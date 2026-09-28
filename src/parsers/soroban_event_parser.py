# src/parsers/soroban_event_parser.py
from dataclasses import dataclass
from typing import List, Any, Dict, Union
import base64

@dataclass
class SwapEvent:
    sender: str
    token_in: str
    token_out: str
    amount_in: int
    amount_out: int

@dataclass
class DepositEvent:
    user: str
    token: str
    amount: int

@dataclass
class LiquidationEvent:
    borrower: str
    liquidator: str
    collateral_asset: str
    debt_asset: str
    liquidated_amount: int

class SorobanEventParser:
    @staticmethod
    def decode_topics(topics: List[str]) -> List[Any]:
        decoded = []
        for topic in topics:
            # Decode XDR b64 topic representation or string symbols
            if topic.startswith("A") or len(topic) > 32:
                try:
                    raw_bytes = base64.b64decode(topic)
                    decoded.append(raw_bytes.hex())
                except Exception:
                    decoded.append(topic)
            else:
                decoded.append(topic)
        return decoded

    @classmethod
    def parse_event(cls, contract_id: str, topics: List[str], data: Dict[str, Any]) -> Union[SwapEvent, DepositEvent, LiquidationEvent, None]:
        clean_topics = cls.decode_topics(topics)
        
        if not clean_topics:
            return None

        event_type = clean_topics[0]

        if event_type == "Swap" or event_type == "swap":
            return SwapEvent(
                sender=data.get("sender", ""),
                token_in=data.get("token_in", ""),
                token_out=data.get("token_out", ""),
                amount_in=int(data.get("amount_in", 0)),
                amount_out=int(data.get("amount_out", 0)),
            )
        elif event_type == "Deposit" or event_type == "deposit":
            return DepositEvent(
                user=data.get("user", ""),
                token=data.get("token", ""),
                amount=int(data.get("amount", 0)),
            )
        elif event_type == "Liquidation" or event_type == "liquidation":
            return LiquidationEvent(
                borrower=data.get("borrower", ""),
                liquidator=data.get("liquidator", ""),
                collateral_asset=data.get("collateral_asset", ""),
                debt_asset=data.get("debt_asset", ""),
                liquidated_amount=int(data.get("liquidated_amount", 0)),
            )

        return None