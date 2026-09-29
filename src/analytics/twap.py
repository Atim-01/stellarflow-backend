from __future__ import annotations

import hashlib
import json
import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class PriceSample:
    """Represents a price sample from an oracle feed for a pool.

    Attributes:
        timestamp: Time at which the price was observed.
        price: Observed price sample value (P_sample).
        volume: Volume associated with the sample (default: 0.0).
        pool_id: Unique identifier of the pool (e.g. 'xlm-usdc').
        feed_id: Identifier of the oracle feed or source (e.g. 'binance', 'coingecko').
        source: Additional source metadata.
    """
    timestamp: datetime
    price: float
    volume: float = 0.0
    pool_id: Optional[str] = None
    feed_id: Optional[str] = None
    source: Optional[str] = None


@dataclass
class TradePoint:
    """Point representing a trade or price sample. Retained for backwards compatibility."""
    timestamp: datetime
    price: float
    volume: float = 0.0
    pool_id: Optional[str] = None
    feed_id: Optional[str] = None
    source: Optional[str] = None


@dataclass
class OutlierAuditRecord:
    """Audit log entry recorded when an outlier price spike is suppressed."""
    pool_id: str
    sample_price: float
    z_score: float
    mean: float
    std_dev: float
    timestamp: datetime
    threshold: float = 3.0
    feed_id: Optional[str] = None
    source: Optional[str] = None
    window_seconds: float = 3600.0
    reason: str = "Outlier price spike detected: |Z| > 3.0"
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "pool_id": self.pool_id,
            "sample_price": self.sample_price,
            "z_score": self.z_score,
            "mean": self.mean,
            "std_dev": self.std_dev,
            "timestamp": self.timestamp.isoformat(),
            "threshold": self.threshold,
            "feed_id": self.feed_id,
            "source": self.source,
            "window_seconds": self.window_seconds,
            "reason": self.reason,
            "created_at": self.created_at.isoformat(),
        }


class PostgresAuditLogger:
    """Audit logger that records suppressed price samples in a PostgreSQL audit database.

    Supports writing to PostgreSQL via SQLAlchemy or raw connections, with an
    in-memory audit trail buffer for fast inspection and testing.
    """

    def __init__(
        self,
        db_url: Optional[str] = None,
        table_name: str = "audit_logs",
        auto_create_table: bool = True,
        engine: Optional[Any] = None,
    ) -> None:
        self.db_url = db_url
        self.table_name = table_name
        self.auto_create_table = auto_create_table
        self._engine = engine
        self._logged_records: List[OutlierAuditRecord] = []
        self._lock = threading.Lock()

        if self._engine is None and self.db_url:
            try:
                from sqlalchemy import create_engine
                self._engine = create_engine(self.db_url)
                if self.auto_create_table:
                    self._ensure_table_exists()
            except Exception as exc:
                logger.warning("Could not initialize database engine for audit logging: %s", exc)

    def _ensure_table_exists(self) -> None:
        """Create the audit table if it does not already exist."""
        if not self._engine:
            return
        try:
            from sqlalchemy import text
            create_sql = text(f"""
                CREATE TABLE IF NOT EXISTS {self.table_name} (
                    id SERIAL PRIMARY KEY,
                    operation_type VARCHAR(100) NOT NULL,
                    actor VARCHAR(256) NOT NULL,
                    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    payload JSONB NOT NULL,
                    record_hash VARCHAR(64) NOT NULL,
                    signature VARCHAR(512) NOT NULL,
                    key_id VARCHAR(256) NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)
            with self._engine.begin() as conn:
                conn.execute(create_sql)
        except Exception as exc:
            logger.debug("Table check/creation skipped or failed: %s", exc)

    def log_suppressed_sample(self, record: OutlierAuditRecord) -> None:
        """Log a suppressed price sample to memory and the PostgreSQL audit database."""
        with self._lock:
            self._logged_records.append(record)

        if self._engine:
            try:
                from sqlalchemy import text
                payload_json = json.dumps(record.to_dict())
                canonical = f"price_spike_suppressed:{record.pool_id}:{record.timestamp.isoformat()}:{payload_json}"
                record_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

                insert_sql = text(f"""
                    INSERT INTO {self.table_name} 
                    (operation_type, actor, timestamp, payload, record_hash, signature, key_id)
                    VALUES 
                    (:op_type, :actor, :timestamp, :payload, :record_hash, :signature, :key_id)
                """)
                with self._engine.begin() as conn:
                    conn.execute(insert_sql, {
                        "op_type": "configuration_change",
                        "actor": f"oracle_feed_monitor:{record.feed_id or 'default'}",
                        "timestamp": record.created_at,
                        "payload": payload_json,
                        "record_hash": record_hash,
                        "signature": f"sig-{record_hash[:16]}",
                        "key_id": "oracle-twap-system",
                    })
                logger.info(
                    "Logged suppressed price spike to PostgreSQL audit database: pool=%s, price=%s, z=%s",
                    record.pool_id, record.sample_price, record.z_score
                )
            except Exception as exc:
                logger.warning("Failed to persist audit log record to PostgreSQL: %s", exc)

    def get_logged_records(self, pool_id: Optional[str] = None) -> List[OutlierAuditRecord]:
        """Return a copy of logged audit records, optionally filtered by pool_id."""
        with self._lock:
            if pool_id is None:
                return list(self._logged_records)
            return [r for r in self._logged_records if r.pool_id == pool_id]

    def clear(self) -> None:
        """Clear the in-memory log buffer."""
        with self._lock:
            self._logged_records.clear()


# Default singleton instance
default_audit_logger = PostgresAuditLogger()


class TWAPEngine:
    """Calculates Time-Weighted Average Price (TWAP) with outlier price spike suppression."""

    ROLLING_WINDOW_DEFAULT: timedelta = timedelta(hours=1)
    Z_SCORE_THRESHOLD_DEFAULT: float = 3.0

    @staticmethod
    def calculate_z_score(
        sample_price: float,
        window_prices: Sequence[float],
    ) -> float:
        """Calculate the price Z-score: Z = (P_sample - mu) / sigma against a rolling window.

        Args:
            sample_price: Current price sample under evaluation (P_sample).
            window_prices: Sequence of historical prices within the rolling window.

        Returns:
            The calculated Z-score.
            Returns 0.0 if fewer than 2 samples exist in the window (insufficient data).
            If sigma == 0 (all historical prices identical):
                - returns 0.0 if sample_price == mu (no deviation)
                - returns +inf or -inf if sample_price != mu (infinite deviation / spike)
        """
        if len(window_prices) < 2:
            return 0.0

        prices_array = np.array(window_prices, dtype=np.float64)
        mu = float(np.mean(prices_array))
        sigma = float(np.std(prices_array))

        if sigma == 0.0:
            if sample_price == mu:
                return 0.0
            return float("inf") if sample_price > mu else float("-inf")

        return (sample_price - mu) / sigma

    @classmethod
    def is_outlier(
        cls,
        sample_price: float,
        window_prices: Sequence[float],
        threshold: float = 3.0,
    ) -> Tuple[bool, float, float, float]:
        """Determine whether sample_price is an outlier given window_prices.

        Returns:
            Tuple of (is_outlier, z_score, mean, std_dev)
        """
        if len(window_prices) < 2:
            return False, 0.0, float(sample_price), 0.0

        prices_array = np.array(window_prices, dtype=np.float64)
        mu = float(np.mean(prices_array))
        sigma = float(np.std(prices_array))

        if sigma == 0.0:
            if sample_price == mu:
                return False, 0.0, mu, 0.0
            z_score = float("inf") if sample_price > mu else float("-inf")
            return True, z_score, mu, 0.0

        z_score = (sample_price - mu) / sigma
        is_spike = abs(z_score) > threshold
        return is_spike, z_score, mu, sigma

    @classmethod
    def filter_price_spikes(
        cls,
        samples: Sequence[Union[PriceSample, TradePoint]],
        window: timedelta = ROLLING_WINDOW_DEFAULT,
        threshold: float = Z_SCORE_THRESHOLD_DEFAULT,
        pool_id: Optional[str] = None,
        audit_logger: Optional[PostgresAuditLogger] = None,
    ) -> List[Union[PriceSample, TradePoint]]:
        """Detect and suppress outlier price spikes where |Z| > threshold against a rolling window.

        Suppressed price samples are excluded from TWAP calculations and logged to the
        PostgreSQL audit database.

        Args:
            samples: Time series of price samples or trade points.
            window: Rolling window duration (default: 1 hour).
            threshold: Z-score threshold for outlier suppression (|Z| > threshold, default: 3.0).
            pool_id: Liquidity pool identifier.
            audit_logger: Audit logger for recording suppressed samples.

        Returns:
            List of clean (non-suppressed) price samples.
        """
        if not samples:
            return []

        logger_to_use = audit_logger or default_audit_logger

        # Sort chronologically
        sorted_samples = sorted(samples, key=lambda s: s.timestamp)
        clean_samples: List[Union[PriceSample, TradePoint]] = []

        for sample in sorted_samples:
            # Baseline prices from clean samples in the rolling window [sample.timestamp - window, sample.timestamp)
            cutoff = sample.timestamp - window
            window_prices = [
                prev.price for prev in clean_samples
                if cutoff <= prev.timestamp < sample.timestamp
            ]

            is_spike, z, mu, sigma = cls.is_outlier(sample.price, window_prices, threshold=threshold)

            if is_spike:
                # Suppress outlier price spike
                target_pool = pool_id or getattr(sample, "pool_id", None) or "unknown-pool"
                feed_id = getattr(sample, "feed_id", None)
                source = getattr(sample, "source", None)

                record = OutlierAuditRecord(
                    pool_id=target_pool,
                    sample_price=sample.price,
                    z_score=z,
                    mean=mu,
                    std_dev=sigma,
                    timestamp=sample.timestamp,
                    threshold=threshold,
                    feed_id=feed_id,
                    source=source,
                    window_seconds=window.total_seconds(),
                    reason=f"Outlier price spike detected: |Z|={abs(z):.4f} > {threshold}",
                )
                logger_to_use.log_suppressed_sample(record)
                logger.warning(
                    "Price sample suppressed from TWAP calculation: pool=%s, price=%.4f, Z=%.2f, mean=%.4f, sigma=%.4f",
                    target_pool, sample.price, z, mu, sigma
                )
            else:
                clean_samples.append(sample)

        return clean_samples

    @staticmethod
    def filter_outliers(
        trades: List[TradePoint],
        variance_threshold: float = 0.50,
    ) -> List[TradePoint]:
        """Legacy filter: removes trades exceeding variance_threshold from moving median."""
        if not trades:
            return []

        prices = [t.price for t in trades]
        median_price = float(np.median(prices))

        if median_price == 0:
            return trades

        filtered_trades = []
        for trade in trades:
            variance = abs(trade.price - median_price) / median_price
            if variance <= variance_threshold:
                filtered_trades.append(trade)

        return filtered_trades

    @classmethod
    def calculate_twap(
        cls,
        trades: List[TradePoint],
        window: timedelta,
        current_time: Optional[datetime] = None,
        use_zscore_filter: bool = True,
        z_threshold: float = Z_SCORE_THRESHOLD_DEFAULT,
        audit_logger: Optional[PostgresAuditLogger] = None,
        pool_id: Optional[str] = None,
    ) -> float:
        """Calculate time-weighted average price over a time window with outlier spike suppression.

        Args:
            trades: List of TradePoint or PriceSample instances.
            window: TWAP integration window duration.
            current_time: Current reference time (defaults to timezone.utc now).
            use_zscore_filter: Whether to apply Z-score spike suppression (|Z| > 3.0 against 1-hour window).
            z_threshold: Z-score cutoff threshold (default: 3.0).
            audit_logger: Optional audit logger for recording suppressed samples.
            pool_id: Pool identifier for audit logging context.

        Returns:
            Time-weighted average price rounded to 6 decimal places.
        """
        if not trades:
            return 0.0

        if current_time is None:
            current_time = datetime.now(timezone.utc)

        start_time = current_time - window

        # Sort trades by timestamp ascending
        sorted_trades = sorted(trades, key=lambda t: t.timestamp)

        # Filter trades within the requested TWAP window
        window_trades = [t for t in sorted_trades if t.timestamp >= start_time]

        # Filter price outliers using Z-score or legacy median variance
        if use_zscore_filter:
            clean_trades = cls.filter_price_spikes(
                window_trades,
                window=cls.ROLLING_WINDOW_DEFAULT,
                threshold=z_threshold,
                pool_id=pool_id,
                audit_logger=audit_logger,
            )
        else:
            clean_trades = cls.filter_outliers(window_trades)

        if not clean_trades:
            return 0.0

        # Compute time-weighted average price using linear interval integration
        total_time_weighted_price = 0.0
        total_time_delta = 0.0

        for i in range(len(clean_trades)):
            current = clean_trades[i]
            # Determine interval duration to the next trade or current_time
            if i < len(clean_trades) - 1:
                next_time = clean_trades[i + 1].timestamp
            else:
                next_time = current_time

            duration = (next_time - current.timestamp).total_seconds()
            if duration > 0:
                total_time_weighted_price += current.price * duration
                total_time_delta += duration

        if total_time_delta == 0:
            return clean_trades[-1].price

        return round(total_time_weighted_price / total_time_delta, 6)

    @classmethod
    def calculate_pool_twap(
        cls,
        pool_id: str,
        samples: Sequence[Union[PriceSample, TradePoint]],
        window: timedelta = ROLLING_WINDOW_DEFAULT,
        current_time: Optional[datetime] = None,
        z_threshold: float = Z_SCORE_THRESHOLD_DEFAULT,
        audit_logger: Optional[PostgresAuditLogger] = None,
    ) -> float:
        """Calculate pool TWAP, suppressing outlier price spikes (|Z| > 3.0) and logging to PostgreSQL audit database.

        Args:
            pool_id: The liquidity pool identifier.
            samples: Sequence of price samples or trade points.
            window: Rolling window duration for TWAP calculation (default: 1 hour).
            current_time: Reference timestamp (default: utcnow).
            z_threshold: Z-score threshold for outlier suppression (default: 3.0).
            audit_logger: Logger for suppressed outlier prices.

        Returns:
            TWAP for the specified pool.
        """
        # Filter samples for this pool if pool_id is specified on samples
        pool_samples = [
            s for s in samples
            if getattr(s, "pool_id", None) is None or getattr(s, "pool_id", None) == pool_id
        ]

        return cls.calculate_twap(
            trades=pool_samples,
            window=window,
            current_time=current_time,
            use_zscore_filter=True,
            z_threshold=z_threshold,
            audit_logger=audit_logger,
            pool_id=pool_id,
        )


class RollingPoolTWAPTracker:
    """Stateful rolling TWAP tracker for oracle feeds of a pool.

    Maintains a rolling 1-hour window of clean price samples and automatically
    suppresses outlier price spikes where |Z| > 3.0, logging them to PostgreSQL.
    """

    def __init__(
        self,
        pool_id: str,
        window: timedelta = TWAPEngine.ROLLING_WINDOW_DEFAULT,
        z_threshold: float = TWAPEngine.Z_SCORE_THRESHOLD_DEFAULT,
        audit_logger: Optional[PostgresAuditLogger] = None,
    ) -> None:
        self.pool_id = pool_id
        self.window = window
        self.z_threshold = z_threshold
        self.audit_logger = audit_logger or default_audit_logger
        self._clean_samples: List[PriceSample] = []
        self._suppressed_records: List[OutlierAuditRecord] = []
        self._lock = threading.Lock()

    def add_sample(
        self,
        price: float,
        timestamp: Optional[datetime] = None,
        volume: float = 0.0,
        feed_id: Optional[str] = None,
        source: Optional[str] = None,
    ) -> bool:
        """Evaluate an incoming price sample.

        Calculates Z-score against the rolling 1-hour window:
        - If |Z| > 3.0: suppresses sample from TWAP and logs to PostgreSQL audit DB. Returns False.
        - If |Z| <= 3.0: adds sample to rolling window. Returns True.
        """
        ts = timestamp or datetime.now(timezone.utc)
        sample = PriceSample(
            timestamp=ts,
            price=price,
            volume=volume,
            pool_id=self.pool_id,
            feed_id=feed_id,
            source=source,
        )

        with self._lock:
            # Evict samples older than window
            cutoff = ts - self.window
            self._clean_samples = [s for s in self._clean_samples if s.timestamp >= cutoff]

            window_prices = [s.price for s in self._clean_samples if s.timestamp < ts]
            is_spike, z, mu, sigma = TWAPEngine.is_outlier(price, window_prices, threshold=self.z_threshold)

            if is_spike:
                record = OutlierAuditRecord(
                    pool_id=self.pool_id,
                    sample_price=price,
                    z_score=z,
                    mean=mu,
                    std_dev=sigma,
                    timestamp=ts,
                    threshold=self.z_threshold,
                    feed_id=feed_id,
                    source=source,
                    window_seconds=self.window.total_seconds(),
                    reason=f"Outlier price spike detected: |Z|={abs(z):.4f} > {self.z_threshold}",
                )
                self._suppressed_records.append(record)
                self.audit_logger.log_suppressed_sample(record)
                return False

            self._clean_samples.append(sample)
            return True

    def get_twap(self, current_time: Optional[datetime] = None) -> float:
        """Compute the current pool TWAP over the rolling window using non-suppressed samples."""
        with self._lock:
            now = current_time or datetime.now(timezone.utc)
            cutoff = now - self.window
            active_clean = [s for s in self._clean_samples if s.timestamp >= cutoff]
            return TWAPEngine.calculate_twap(
                trades=active_clean,
                window=self.window,
                current_time=now,
                use_zscore_filter=False,  # Already filtered upon ingestion
            )

    def get_clean_samples(self) -> List[PriceSample]:
        """Return a copy of currently retained clean samples."""
        with self._lock:
            return list(self._clean_samples)

    def get_suppressed_records(self) -> List[OutlierAuditRecord]:
        """Return a copy of suppressed audit records."""
        with self._lock:
            return list(self._suppressed_records)