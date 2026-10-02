# src/models/invariant_monitoring.py
from sqlalchemy import Column, Integer, String, Numeric, DateTime, BigInteger, Index, func
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()

class PoolState(Base):
    __tablename__ = 'pool_states'

    id = Column(Integer, primary_key=True, autoincrement=True)
    pool_id = Column(String(64), nullable=False, index=True)
    reserve_a = Column(Numeric(38, 18), nullable=False)
    reserve_b = Column(Numeric(38, 18), nullable=False)
    total_shares = Column(Numeric(38, 18), nullable=False)
    ledger_sequence = Column(BigInteger, nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index('idx_pool_ledger', 'pool_id', 'ledger_sequence'),
    )

class VaultPosition(Base):
    __tablename__ = 'vault_positions'

    id = Column(Integer, primary_key=True, autoincrement=True)
    account_id = Column(String(56), nullable=False, index=True)
    vault_id = Column(String(64), nullable=False, index=True)
    collateral_balance = Column(Numeric(38, 18), nullable=False)
    debt_balance = Column(Numeric(38, 18), nullable=False)
    ledger_sequence = Column(BigInteger, nullable=False, index=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index('idx_account_vault', 'account_id', 'vault_id'),
    )

class InvariantAuditLog(Base):
    __tablename__ = 'invariant_audit_logs'

    id = Column(Integer, primary_key=True, autoincrement=True)
    invariant_name = Column(String(100), nullable=False)
    is_valid = Column(Integer, nullable=False)
    discrepancy_amount = Column(Numeric(38, 18), default=0)
    ledger_sequence = Column(BigInteger, nullable=False, index=True)
    checked_at = Column(DateTime(timezone=True), server_default=func.now())