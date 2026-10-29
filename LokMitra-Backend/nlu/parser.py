import re
import unicodedata
from collections.abc import Iterable, Mapping
from typing import Any

_NUMBER_WORDS = {
    "zero": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
    "ek": 1,
    "do": 2,
    "teen": 3,
    "chaar": 4,
    "char": 4,
    "paanch": 5,
    "panch": 5,
    "che": 6,
    "saat": 7,
    "aath": 8,
    "nau": 9,
    "das": 10,
    "bees": 20,
    "tees": 30,
    "chalis": 40,
    "pachaas": 50,
    "sau": 100,
    "hundred": 100,
    "vanda": 100,
    "vandla": 100,
    "vandalu": 100,
    "nooru": 100,
    "ainoodlu": 500,
    "aidu": 5,
    "aindu": 5,
    "okati": 1,
    "rendu": 2,
    "moodu": 3,
    "naalugu": 4,
    "aaru": 6,
    "edu": 7,
    "ఒకటి": 1,
    "రెండు": 2,
    "మూడు": 3,
    "నాలుగు": 4,
    "ఐదు": 5,
    "అయిదు": 5,
    "ఆరు": 6,
    "ఏడు": 7,
    "ఎనిమిది": 8,
    "తొమ్మిది": 9,
    "పది": 10,
    "వంద": 100,
    "వందలు": 100,
    "వెయ్యి": 1000,
    "ఐదువందలు": 500,
    "एक": 1,
    "दो": 2,
    "तीन": 3,
    "चार": 4,
    "पांच": 5,
    "पाँच": 5,
    "छह": 6,
    "सात": 7,
    "आठ": 8,
    "नौ": 9,
    "दस": 10,
    "बीस": 20,
    "तीस": 30,
    "चालीस": 40,
    "पचास": 50,
    "सौ": 100,
    "सैकड़ा": 100,
    "हजार": 1000,
    "हज़ार": 1000,
    "and": 0,
}
_SCALE_WORDS = {
    "hundred",
    "sau",
    "vanda",
    "vandla",
    "vandalu",
    "nooru",
    "వంద",
    "వందలు",
    "सौ",
    "सैकड़ा",
}
_THOUSAND_WORDS = {"thousand", "हजार", "हज़ार", "వెయ్యి"}
_NUMERIC_TOKEN = re.compile(r"^[0-9][0-9,]*(?:\.[0-9]{1,2})?$")
_MAX_AMOUNT_PAISE = 1_000_000_000
_NON_AMOUNT_UNITS = {"day", "days", "din", "दिन", "రోజు", "రోజులు"}


def _normalize(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    digits: list[str] = []
    for character in normalized:
        try:
            digits.append(str(unicodedata.decimal(character)))
        except ValueError:
            digits.append(character)
    return "".join(digits)


def _words(text: str) -> list[str]:
    normalized = _normalize(text)
    tokens: list[str] = []
    current: list[str] = []
    for index, character in enumerate(normalized):
        category = unicodedata.category(character)
        is_decimal_separator = (
            character in {".", ","}
            and bool(current)
            and current[-1].isdigit()
            and index + 1 < len(normalized)
            and normalized[index + 1].isdigit()
        )
        if (
            category[0] in {"L", "N"}
            or category[0] == "M"
            and current
            or is_decimal_separator
        ):
            current.append(character)
        elif current:
            tokens.append("".join(current))
            current = []
    if current:
        tokens.append("".join(current))
    return tokens


def _parse_number_tokens(tokens: list[str], start: int) -> tuple[int, int] | None:
    token = tokens[start]
    match = _NUMERIC_TOKEN.fullmatch(token)
    if match:
        number = token.replace(",", "")
        whole_text, separator, fraction_text = number.partition(".")
        value = int(whole_text) * 100
        if separator:
            value += int((fraction_text + "00")[:2])
        consumed = 1
        if start + consumed < len(tokens):
            scale = tokens[start + consumed]
            if scale in _SCALE_WORDS:
                value *= 100
                consumed += 1
            elif scale in _THOUSAND_WORDS:
                value *= 1000
                consumed += 1
        return value, consumed

    if token not in _NUMBER_WORDS:
        return None
    total = 0
    group = 0
    consumed = 0
    found = False
    while start + consumed < len(tokens):
        current = tokens[start + consumed]
        if current not in _NUMBER_WORDS:
            break
        number = _NUMBER_WORDS[current]
        found = True
        consumed += 1
        if current in _SCALE_WORDS:
            group = max(group, 1) * 100
        elif current in _THOUSAND_WORDS:
            total += max(group, 1) * 1000
            group = 0
        else:
            group += number
    if not found:
        return None
    return (total + group) * 100, consumed


def _extract_amounts(text: str) -> list[int]:
    tokens = _words(text)
    amounts: list[int] = []
    index = 0
    while index < len(tokens):
        if index + 1 < len(tokens) and tokens[index + 1] in _NON_AMOUNT_UNITS:
            index += 2
            continue
        parsed = _parse_number_tokens(tokens, index)
        if parsed is None:
            index += 1
            continue
        amount_paise, consumed = parsed
        if amount_paise > 0 and amount_paise not in amounts:
            amounts.append(amount_paise)
        index += consumed
    return amounts


def _edit_distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for row, left_char in enumerate(left, start=1):
        current = [row]
        for column, right_char in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def _customer_candidates(
    text: str, customers: Iterable[Mapping[str, Any]]
) -> tuple[list[dict[str, Any]], bool]:
    transcript_tokens = _words(text)
    scored: list[dict[str, Any]] = []
    for customer in customers:
        name = customer.get("display_name")
        customer_id = customer.get("id")
        if not isinstance(name, str) or customer_id is None:
            continue
        name_tokens = _words(name)
        token_scores: list[float] = []
        for name_token in name_tokens:
            best = 0.0
            for transcript_token in transcript_tokens:
                distance = _edit_distance(name_token, transcript_token)
                tolerance = max(1, len(name_token) // 5)
                if distance <= tolerance:
                    best = max(
                        best,
                        1.0 - distance / max(len(name_token), len(transcript_token)),
                    )
            token_scores.append(best)
        score = sum(token_scores) / len(token_scores) if token_scores else 0.0
        if score >= 0.6:
            scored.append({"id": customer_id, "display_name": name, "score": score})
    scored.sort(
        key=lambda candidate: (
            -candidate["score"],
            candidate["display_name"].casefold(),
            str(candidate["id"]),
        )
    )
    candidates = scored[:3]
    ambiguous = (
        len(candidates) > 1 and candidates[0]["score"] - candidates[1]["score"] <= 0.1
    )
    return candidates, ambiguous


def parse(text: str, customers: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    normalized = _normalize(text)
    words = set(_words(text))
    amount_candidates = _extract_amounts(text)
    amount_paise = (
        amount_candidates[0]
        if len(amount_candidates) == 1 and amount_candidates[0] <= _MAX_AMOUNT_PAISE
        else None
    )

    remind_words = {"remind", "reminder", "గుర్తుచేయి", "గుర్తు", "याद", "दिलाना"}
    summary_words = {"summary", "సారాంశం", "ఈరోజు", "आज", "today", "రోజు"}
    balance_words = {"balance", "ఎంత", "कितना", "कितनी", "how", "much"}
    payment_words = {
        "diya",
        "diyaa",
        "ichanu",
        "ichcha",
        "mila",
        "jama",
        "paid",
        "received",
        "payment",
        "చెల్లించాను",
        "ఇచ్చాను",
        "ముట్టాయి",
        "दिया",
        "मिला",
        "जमा",
        "भुगतान",
    }
    credit_words = {
        "baaki",
        "बाकी",
        "బాకీ",
        "udhaar",
        "udhar",
        "उधार",
        "credit",
        "ఖాతా",
    }
    pending_words = {"pending", "बकाया"}

    if words & remind_words:
        intent = "remind_customer"
    elif words & summary_words:
        intent = "daily_summary"
    elif words & balance_words:
        intent = "show_balance"
    elif words & payment_words:
        intent = "record_payment"
    elif words & pending_words:
        intent = "pending_dues"
    elif words & credit_words and amount_paise is not None:
        intent = "add_credit"
    elif words & credit_words or any(
        term in normalized for term in ("pending dues", "बाकी बताओ", "బాకీ చెప్పు")
    ):
        intent = "pending_dues"
    else:
        intent = "unknown"

    candidates, ambiguous_customer = _customer_candidates(text, customers)
    needs_review: list[str] = []
    if intent == "unknown":
        needs_review.append("uncertain_intent")
    if intent in {"add_credit", "record_payment"} and amount_paise is None:
        needs_review.append("missing_amount")
    if len(amount_candidates) > 1:
        needs_review.append("ambiguous_amount")
    if amount_candidates and any(
        amount > _MAX_AMOUNT_PAISE for amount in amount_candidates
    ):
        needs_review.append("amount_out_of_range")
    if ambiguous_customer:
        needs_review.append("ambiguous_customer")

    confidence = 0.95 if intent != "unknown" else 0.0
    if needs_review:
        confidence = min(confidence, 0.5)
    return {
        "intent": intent,
        "customer_candidates": candidates,
        "amount_paise": amount_paise,
        "confidence": confidence,
        "needs_review": needs_review,
    }
