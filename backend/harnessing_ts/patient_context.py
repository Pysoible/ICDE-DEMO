"""Bounded lexical symptom scope and published-report facts, not clinical triage.

Only explicit, local denials bypass the urgent keyword gate. Unknown scope stays
conservative. All displayed symptoms retain an exact user excerpt and turn index.
"""
from __future__ import annotations

import re

SYMPTOMS = re.compile(
    r"(?P<chest_pain>胸痛|胸口(?:疼痛|痛)|胸部疼痛|chest pain)|"
    r"(?P<breathlessness>呼吸困难|气短|喘不过气|shortness of breath|difficulty breathing|breathless(?:ness)?)|"
    r"(?P<fainting>晕厥|昏厥|晕倒|昏倒|faint(?:ing|ed)?)|"
    r"(?P<severe>severe symptoms)|"
    r"(?P<palpitations>心慌|心悸|心跳明显|心跳(?:很快|加快|不齐)|palpitations?|racing heart|heart (?:feels like it is |is )?racing)|"
    r"(?P<fatigue>疲倦|疲劳|乏力|fatigue|tired(?:ness)?)", re.I)
URGENT = {'chest_pain', 'breathlessness', 'fainting', 'severe'}
BREAK = re.compile(r"[，,。.!！?？;；\n]|但是|不过|然而|但|却|\b(?:but|however|yet)\b", re.I)
DENIAL = re.compile(
    r"(?:(?:没有|没|无|未曾|未|否认|不伴有|不伴|并无|从未)"
    r"(?:(?:出现|发生|伴随|感觉|明显|持续|任何|过|的|有)|\s)*|"
    r"(?:\bno|\bwithout|\bden(?:y|ies|ied)|\bdo not have|\bdon't have|\bdon’t have|"
    r"\bnot (?:having|experiencing)|\bhave not (?:had|experienced)|\bhaven't (?:had|experienced)|"
    r"\bnever (?:had|experienced))\s*(?:(?:any|current|recent|significant|severe|new|episodes? of)\s+)*)$", re.I)
UNCERTAIN = re.compile(r"不确定|不知道|不能确定|有没有|是否|好像|可能|是不是|\b(?:not sure|unsure|maybe|might|whether)\b", re.I)
DOUBLE_NEGATIVE = re.compile(r"不是|并非|不能说|不代表|不等于|不能排除|未必|(?:没有|没|未)\s*$|\b(?:not|doesn't mean|does not mean|no reason to)\b", re.I)
TERM_QUESTION = re.compile(
    r"\s*(?:(?:什么是|请解释)(?:胸痛|呼吸困难|气短|晕厥|昏厥|晕倒)|"
    r"(?:胸痛|呼吸困难|气短|晕厥|昏厥|晕倒)(?:是什么意思|是什么|的意思)|"
    r"(?:what (?:is|does)|define|explain)\s+(?:chest pain|shortness of breath|difficulty breathing|fainting)(?:\s+mean)?)\s*[?？。.!！]*\s*", re.I)


def symptom_mentions(text: str) -> list[dict]:
    """Recognize only explicit assertion/denial; never infer absent symptoms."""
    result = []
    previous = None
    for match in SYMPTOMS.finditer(text):
        boundary = max((m.end() for m in BREAK.finditer(text[:match.start()])), default=0)
        prefix = text[boundary:match.start()]
        denial = DENIAL.search(prefix)
        uncertain = bool(UNCERTAIN.search(prefix))
        status = 'uncertain' if uncertain else 'reported'
        scope_start = boundary
        if denial and not uncertain:
            status = 'uncertain' if DOUBLE_NEGATIVE.search(prefix[:denial.start()]) else 'denied'
        # Carry a denial ONLY through a list of symptoms, not a new predicate,
        # subject, adversative, sentence, or unrelated denied event.
        if not denial and previous and previous['status'] == 'denied':
            between = text[previous['_end']:match.start()]
            if re.fullmatch(r"[\s、，,与和及或也]*(?:(?:and|or|nor)\s*)?", between, re.I):
                status = 'denied'
                scope_start = previous['_start']
        # Chinese post-positioned denial, e.g. "胸痛没有，心慌有".
        suffix = text[match.end():]
        if re.match(r"\s*(?:没有|无|否认)(?=[，,。.!！?？;；\n]|$)", suffix):
            status = 'denied'
        # Not "no chest pain now?" interpreted as a definite absence.
        if re.match(r"\s*[?？]", suffix) and (denial or status == 'denied'):
            status = 'uncertain'
        if status == 'denied' and re.match(r"[，,；;\s]*(?:但是|但|不过)?(?:现在|刚才|目前)(?:又)?有(?:了)?(?=[，,。.!！?？;；\n]|$)", suffix):
            status = 'uncertain'
        quote_end = match.end()
        post = re.match(r"\s*(?:没有|无|否认)(?=[，,。.!！?？;；\n]|$)", suffix)
        if post:
            quote_end += post.end()
        quote_start = scope_start if status == 'denied' else boundary
        # Keep the exact literal phrase, including the negation. Very long
        # prefixes are not trusted as denial evidence; do not cut away "没有".
        quote = text[quote_start:quote_end].strip()
        if len(quote) > 180:
            quote = text[max(boundary, match.start()-60):quote_end].strip()
        entry = {'name': match.lastgroup, 'status': status, 'quote': quote,
                 '_start': scope_start, '_end': match.end()}
        result.append(entry)
        previous = entry
    if TERM_QUESTION.fullmatch(text):
        for item in result:
            item['status'] = 'educational'
    return [{k: v for k, v in item.items() if not k.startswith('_')} for item in result]


def needs_urgent_guidance(question: str) -> bool:
    # Not a medical classifier: unhandled, positive, or uncertain urgent mentions
    # keep priority. Explicit local denials and exact term questions alone bypass.
    return any(m['name'] in URGENT and m['status'] not in ('denied', 'educational')
               for m in symptom_mentions(question))


def patient_context(question: str, history: list[dict], report: dict) -> dict:
    turns = [h['text'] for h in history[-6:] if h.get('role') == 'user' and isinstance(h.get('text'), str)] + [question]
    # Latest explicit mention per symptom, preserving a same-turn conflict.
    symptoms = []
    for turn_index, text in enumerate(turns):
        mentions = symptom_mentions(text)
        names = {m['name'] for m in mentions}
        symptoms = [m for m in symptoms if m['name'] not in names]
        symptoms.extend(dict(m, turn=turn_index) for m in mentions)
    labels = list(report.get('labels') or [])
    claim = None
    # A question or negation is not a claim. Only a narrow explicit assertion is
    # checked here; the model must use the published snapshot for other wording.
    for pattern, kind in (
        (r"(?:我看到)?报告(?:里|中|上|里面)(?:的|有|写着|显示|提示)?(?:几个|多[个种]|一些)?异常(?:标签|提示)|\b(?:my|the) report (?:shows|has|contains) (?:several |multiple |some )?abnormal (?:labels|findings)\b", 'abnormal'),
        (r"报告(?:写着|显示|提示|是)(?:完全)?正常|\b(?:my|the) report (?:is|says) (?:completely )?normal\b", 'normal'),
    ):
        match = re.search(pattern, question, re.I)
        if match and not re.search(r"没有|不是|是否|是不是|\b(?:not|whether)\b", question[max(0, match.start()-8):match.end()], re.I):
            conflict = bool(labels) and ((kind == 'abnormal' and set(labels) == {'NORM'}) or (kind == 'normal' and bool(set(labels)-{'NORM'})))
            claim = {'kind': kind, 'quote': match.group(), 'conflict': conflict}
            break
    return {'symptoms': symptoms[-16:],
            'report': {'revision': report['revision'], 'labels': labels},
            'reportClaim': claim,
            'scope': 'explicit_user_statements_and_published_snapshot_not_clinical_validation'}


def context_quote_candidates(question: str, history: list[dict]) -> list[str]:
    """Short exact source spans; no paraphrase, normalization or assistant text."""
    turns = [h['text'] for h in history[-6:] if h.get('role') == 'user' and isinstance(h.get('text'), str)] + [question]
    candidates = []
    for text in turns:
        for clause in re.split(r'[，,。.!！?？;；\n]', text):
            clause = clause.strip()
            if 2 <= len(clause) <= 160 and clause not in candidates:
                candidates.append(clause)
    return candidates[-24:]
