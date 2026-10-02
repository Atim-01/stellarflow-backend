"""Add capital allocation and rebalancing tables

Revision ID: 0007_add_capital_allocation_rebalancing
Revises: 0006_add_shielded_note_indexer
Create Date: 2026-09-24 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision = '0007_add_capital_allocation_rebalancing'
down_revision = '0006_add_shielded_note_indexer'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create vault_strategy table
    op.create_table(
        'vault_strategy',
        sa.Column('id', sa.String(length=128), nullable=False, comment='Unique strategy identifier'),
        sa.Column('vault_address', sa.String(length=56), nullable=False, comment='On-chain vault contract address'),
        sa.Column('strategy_type', sa.String(length=32), nullable=False, comment='Strategy category (LENDING, STAKING, LP_FARMING)'),
        sa.Column('asset', sa.String(length=16), nullable=False, comment='Primary asset ticker'),
        sa.Column('current_apy', sa.Numeric(precision=10, scale=7), nullable=False, comment='Current APY (fractional)'),
        sa.Column('historical_apy_mean', sa.Numeric(precision=10, scale=7), nullable=True, comment='Mean historical APY'),
        sa.Column('historical_apy_std', sa.Numeric(precision=10, scale=7), nullable=True, comment='APY standard deviation (risk)'),
        sa.Column('tvl', sa.Numeric(precision=32, scale=7), nullable=False, comment='Total value locked'),
        sa.Column('capacity', sa.Numeric(precision=32, scale=7), nullable=True, comment='Maximum vault capacity (null = unlimited)'),
        sa.Column('risk_score', sa.Numeric(precision=3, scale=2), nullable=False, comment='Risk rating 0.0-1.0'),
        sa.Column('enabled', sa.Boolean(), server_default=sa.text('true'), nullable=False, comment='Strategy enabled for allocation'),
        sa.Column('metadata', JSONB(astext_type=sa.Text()), nullable=True, comment='Additional strategy configuration'),
        sa.Column('last_apy_update', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False, comment='Last APY update timestamp'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False, comment='Strategy registration timestamp'),
        sa.PrimaryKeyConstraint('id'),
        comment='Yield strategy configuration for vaults'
    )
    
    op.create_index('ix_vault_strategy_vault_address', 'vault_strategy', ['vault_address'])
    op.create_index('ix_vault_strategy_strategy_type', 'vault_strategy', ['strategy_type'])
    op.create_index('ix_vault_strategy_asset', 'vault_strategy', ['asset'])
    op.create_index('ix_vault_strategy_enabled', 'vault_strategy', ['enabled'])
    op.create_index('ix_vault_strategy_last_apy_update', 'vault_strategy', ['last_apy_update'])

    # Create capital_allocation table
    op.create_table(
        'capital_allocation',
        sa.Column('id', sa.String(length=64), nullable=False, comment='Allocation record ID'),
        sa.Column('strategy_id', sa.String(length=128), nullable=False, comment='Reference to vault_strategy.id'),
        sa.Column('allocated_amount', sa.Numeric(precision=32, scale=7), nullable=False, comment='Capital allocated to strategy'),
        sa.Column('target_weight', sa.Numeric(precision=5, scale=4), nullable=False, comment='Target portfolio weight (fractional)'),
        sa.Column('current_weight', sa.Numeric(precision=5, scale=4), nullable=False, comment='Current portfolio weight'),
        sa.Column('last_rebalance', sa.DateTime(timezone=True), nullable=True, comment='Last rebalancing timestamp'),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False, comment='Last update timestamp'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('strategy_id', name='uq_allocation_strategy'),
        comment='Current capital allocation across vault strategies'
    )
    
    op.create_index('ix_capital_allocation_strategy_id', 'capital_allocation', ['strategy_id'])
    op.create_index('ix_capital_allocation_last_rebalance', 'capital_allocation', ['last_rebalance'])
    op.create_index('ix_allocation_updated', 'capital_allocation', ['updated_at'])

    # Create rebalancing_history table
    op.create_table(
        'rebalancing_history',
        sa.Column('id', sa.String(length=64), nullable=False, comment='Rebalancing operation ID'),
        sa.Column('triggered_at', sa.DateTime(timezone=True), nullable=False, comment='Rebalancing trigger timestamp'),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True, comment='Completion timestamp'),
        sa.Column('status', sa.String(length=16), nullable=False, comment='Operation status (PENDING, IN_PROGRESS, COMPLETED, FAILED)'),
        sa.Column('total_capital', sa.Numeric(precision=32, scale=7), nullable=False, comment='Total capital under management'),
        sa.Column('drift_magnitude', sa.Numeric(precision=5, scale=4), nullable=False, comment='Max allocation drift magnitude'),
        sa.Column('target_allocations', JSONB(astext_type=sa.Text()), nullable=False, comment='Computed target allocation vector W_target'),
        sa.Column('previous_allocations', JSONB(astext_type=sa.Text()), nullable=False, comment='Previous allocation state'),
        sa.Column('movements', JSONB(astext_type=sa.Text()), nullable=True, comment='Capital movements (from -> to)'),
        sa.Column('transaction_hashes', JSONB(astext_type=sa.Text()), nullable=True, comment='On-chain transaction hashes'),
        sa.Column('aggregate_apy_before', sa.Numeric(precision=10, scale=7), nullable=True, comment='Portfolio APY before rebalancing'),
        sa.Column('aggregate_apy_after', sa.Numeric(precision=10, scale=7), nullable=True, comment='Portfolio APY after rebalancing'),
        sa.Column('execution_cost', sa.Numeric(precision=18, scale=7), nullable=True, comment='Gas costs and fees'),
        sa.Column('error_message', sa.Text(), nullable=True, comment='Error details if failed'),
        sa.Column('metadata', JSONB(astext_type=sa.Text()), nullable=True, comment='Additional execution context'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False, comment='Record creation timestamp'),
        sa.PrimaryKeyConstraint('id'),
        comment='Audit trail of capital rebalancing operations'
    )
    
    op.create_index('ix_rebalancing_history_triggered_at', 'rebalancing_history', ['triggered_at'])
    op.create_index('ix_rebalancing_history_status', 'rebalancing_history', ['status'])
    op.create_index('ix_rebalancing_history_created_at', 'rebalancing_history', ['created_at'])
    op.create_index('ix_rebalancing_status_time', 'rebalancing_history', ['status', 'triggered_at'])


def downgrade() -> None:
    op.drop_index('ix_rebalancing_status_time', table_name='rebalancing_history')
    op.drop_index('ix_rebalancing_history_created_at', table_name='rebalancing_history')
    op.drop_index('ix_rebalancing_history_status', table_name='rebalancing_history')
    op.drop_index('ix_rebalancing_history_triggered_at', table_name='rebalancing_history')
    op.drop_table('rebalancing_history')
    
    op.drop_index('ix_allocation_updated', table_name='capital_allocation')
    op.drop_index('ix_capital_allocation_last_rebalance', table_name='capital_allocation')
    op.drop_index('ix_capital_allocation_strategy_id', table_name='capital_allocation')
    op.drop_table('capital_allocation')
    
    op.drop_index('ix_vault_strategy_last_apy_update', table_name='vault_strategy')
    op.drop_index('ix_vault_strategy_enabled', table_name='vault_strategy')
    op.drop_index('ix_vault_strategy_asset', table_name='vault_strategy')
    op.drop_index('ix_vault_strategy_strategy_type', table_name='vault_strategy')
    op.drop_index('ix_vault_strategy_vault_address', table_name='vault_strategy')
    op.drop_table('vault_strategy')
