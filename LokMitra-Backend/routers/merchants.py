from typing import Annotated
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

from auth import get_merchant_id, get_verified_claims
from database import get_connection
from models import MerchantMeRequest, MerchantMeResponse

router = APIRouter(prefix="/api/v1/merchants", tags=["merchants"])


@router.post("/me", response_model=MerchantMeResponse)
async def create_merchant_profile(
    payload: MerchantMeRequest,
    merchant_id: Annotated[UUID, Depends(get_merchant_id)],
    claims: Annotated[dict[str, object], Depends(get_verified_claims)],
    connection: Annotated[asyncpg.Connection, Depends(get_connection)],
) -> MerchantMeResponse:
    phone_number = claims.get("phone")
    if (
        not isinstance(phone_number, str)
        or not phone_number.strip()
        or not 8 <= len(phone_number) <= 32
    ):
        raise HTTPException(status_code=422, detail="Invalid request.")
    await connection.execute(
        """
        SELECT public.upsert_merchant_profile($1, $2, $3, $4)
        """,
        merchant_id,
        phone_number,
        payload.business_name,
        payload.preferred_language,
    )
    row = await connection.fetchrow(
        """
        SELECT id, phone_number, business_name, preferred_language, created_at
        FROM public.merchants
        WHERE id = $1
        """,
        merchant_id,
    )
    if row is None:
        raise RuntimeError("Merchant profile could not be loaded")
    return MerchantMeResponse(
        id=row["id"],
        phone_number=row["phone_number"],
        business_name=row["business_name"],
        preferred_language=row["preferred_language"],
        created_at=row["created_at"],
    )
