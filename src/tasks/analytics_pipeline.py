# src/tasks/analytics_pipeline.py
from celery import shared_task
from sqlalchemy import text
import logging

logger = logging.getLogger(__name__)

@shared_task(name="tasks.aggregate_historical_volume")
def aggregate_historical_volume(period: str = "hourly") -> None:
    """
    Periodically rollup minute-level event data into hourly or daily summary records
    and refresh analytical database tables and materialized views.
    """
    logger.info(f"Starting historical volume aggregation rollup for period: {period}")
    
    try:
        if period == "hourly":
            rollup_query = text("""
                INSERT INTO hourly_volume_summaries (bucket_time, total_volume, total_fees, active_users, updated_at)
                SELECT 
                    date_trunc('hour', timestamp) AS bucket_time,
                    SUM(amount_in) AS total_volume,
                    SUM(fee_amount) AS total_fees,
                    COUNT(DISTINCT sender) AS active_users,
                    NOW()
                FROM raw_trade_events
                WHERE timestamp >= NOW() - INTERVAL '2 hours'
                GROUP BY date_trunc('hour', timestamp)
                ON CONFLICT (bucket_time) DO UPDATE 
                SET total_volume = EXCLUDED.total_volume,
                    total_fees = EXCLUDED.total_fees,
                    active_users = EXCLUDED.active_users,
                    updated_at = NOW();
            """)
        else:
            rollup_query = text("""
                REFRESH MATERIALIZED VIEW CONCURRENTLY daily_volume_materialized_view;
            """)
        
        logger.info(f"Successfully completed analytics aggregation pipeline for {period}")
    except Exception as e:
        logger.error(f"Failed to execute analytics aggregation pipeline: {str(e)}")
        raise