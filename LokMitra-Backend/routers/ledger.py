from typing import Annotated
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends

from auth import get_merchant_id
from database import get_connection
from models import LedgerCustomer

router = APIRouter(prefix="/api/v1/ledger", tags=["ledger"])


@router.get("/customers", response_model=list[LedgerCustomer])
async def get_ledger_customers(
    merchant_id: Annotated[UUID, Depends(get_merchant_id)],
    connection: Annotated[asyncpg.Connection, Depends(get_connection)],
) -> list[LedgerCustomer]:
    rows = await connection.fetch(
        """
        SELECT id, display_name, phone_number, owed_paise, refund_paise, payable_paise
        FROM public.customer_balances
        WHERE merchant_id = $1
        ORDER BY display_name, id
        """,
        merchant_id,
    )
    return [
        LedgerCustomer(
            id=row["id"],
            display_name=row["display_name"],
            phone_number=row["phone_number"],
            owed_paise=int(row["owed_paise"]),
            refund_paise=int(row["refund_paise"]),
            payable_paise=int(row["payable_paise"]),
        )
        for row in rows
    ]
