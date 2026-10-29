from uuid import uuid4

import pytest

from nlu.parser import parse


@pytest.mark.parametrize(
    ("text", "intent", "amount_paise"),
    [
        ("credit sale 500 rupees", "add_credit", 50_000),
        ("sold on credit for ₹500", "add_credit", 50_000),
        ("500 baaki", "add_credit", 50_000),
        ("udhaar 250", "add_credit", 25_000),
        ("received 125 rupees", "record_payment", 12_500),
        ("paid 2.50", "record_payment", 250),
        ("Ravi ko 200 diya", "record_payment", 20_000),
        ("Raju ne 300 jama kiya", "record_payment", 30_000),
        ("mila 75", "record_payment", 7_500),
        ("balance for Ravi", "show_balance", None),
        ("Ramu ka balance kitna", "show_balance", None),
        ("pending dues", "pending_dues", None),
        ("pending amount", "pending_dues", None),
        ("aaj ka summary", "daily_summary", None),
        ("daily summary today", "daily_summary", None),
        ("remind Ravi tomorrow", "remind_customer", None),
        ("paanch sau baaki", "add_credit", 50_000),
        ("Ravi ko paanch sau rupay diya", "record_payment", 50_000),
        ("ek sau bees rupay jama", "record_payment", 12_000),
        ("do sau pending", "pending_dues", 20_000),
        ("रामू को १२३ रुपये दिया", "record_payment", 12_300),
        ("पाँच सौ बाकी", "add_credit", 50_000),
        ("तीन सौ जमा", "record_payment", 30_000),
        ("उधार २५०", "add_credit", 25_000),
        ("बकाया", "pending_dues", None),
        ("आज का summary", "daily_summary", None),
        ("याद दिलाना Ravi", "remind_customer", None),
        ("రాము కి ౫౦౦ బాకీ", "add_credit", 50_000),
        ("ఐదువందలు బాకీ", "add_credit", 50_000),
        ("ఐదు వందలు", "unknown", 50_000),
        ("ramu ki 5 hundred baaki", "add_credit", 50_000),
        ("Ravi ki 1౦0 baaki", "add_credit", 10_000),
        ("₹500 rupees received", "record_payment", 50_000),
        ("500 rupayalu ichanu", "record_payment", 50_000),
        ("Ramu ko 400 rupay diya", "record_payment", 40_000),
        ("remind Raju after two days", "remind_customer", None),
        ("what is the total balance", "show_balance", None),
    ],
)
def test_multilingual_parser_table(
    text: str, intent: str, amount_paise: int | None
) -> None:
    result = parse(text, [])
    assert result["intent"] == intent
    assert result["amount_paise"] == amount_paise
    if amount_paise is not None:
        assert type(result["amount_paise"]) is int


def test_missing_money_amount_requires_review() -> None:
    result = parse("Ramu ki baaki", [])
    assert result["intent"] == "pending_dues"
    assert "missing_amount" not in result["needs_review"]
    result = parse("Ramu ko diya", [])
    assert result["intent"] == "record_payment"
    assert "missing_amount" in result["needs_review"]


def test_ambiguous_customer_is_flagged() -> None:
    customers = [
        {"id": uuid4(), "display_name": "Ramu"},
        {"id": uuid4(), "display_name": "Raju"},
    ]
    result = parse("Ramu Raju ki 500 baaki", customers)
    assert "ambiguous_customer" in result["needs_review"]


def test_amount_parsing_does_not_convert_to_float(monkeypatch) -> None:
    def reject_float(*args, **kwargs):
        raise AssertionError("Amount parsing must not call float")

    monkeypatch.setattr("builtins.float", reject_float)
    result = parse("₹500 baaki", [])
    assert result["amount_paise"] == 50_000
    assert type(result["amount_paise"]) is int


def test_customer_matching_uses_tokens_and_edit_distance() -> None:
    customer_names = ["Ramu", "Raju", "Ravi", "Suresh"]
    customers = [{"id": uuid4(), "display_name": name} for name in customer_names]
    ramu = parse("ramu ki 500 baaki", customers)["customer_candidates"]
    ravi = parse("ravi ko 200 diya", customers)["customer_candidates"]
    assert ramu[0]["display_name"] == "Ramu"
    assert ravi[0]["display_name"] == "Ravi"
