"""Report-bound understanding support; never changes an assessment or report."""
from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from harnessing_ts.expert_collaboration import complete_json, prompt
from harnessing_ts.patient_context import needs_urgent_guidance, patient_context, context_quote_candidates


class PatientGuideInputError(ValueError):
    pass


class ContextUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quote: str = Field(min_length=2, max_length=160)
    focus: str = Field(default="", max_length=700)
    focusField: Literal['explanation','symptoms','dailyCare','medication','nextQuestion'] = 'explanation'


class PatientCareFields(BaseModel):
    """Optional general education; never a patient-specific prescription."""
    symptoms: str = Field(default="", max_length=600)
    dailyCare: str = Field(default="", max_length=600)
    medication: str = Field(default="", max_length=700)
    contextUpdates: list[ContextUpdate] = Field(default_factory=list, max_length=3)
    followUpQuestion: str = Field(default="", max_length=180)


# Remove only standalone identity boilerplate from generated display text, never
# authored reports, case-specific uncertainty, medicine cautions or urgent advice.
IDENTITY_BOILERPLATE = re.compile(
    r"(?:请注意[，,:：]?\s*)?(?:本(?:系统|演示|回答|内容)|以上(?:内容|回答)|这些信息|此回答)"
    r"(?:仅供(?:参考|学习|演示)|仅用于(?:演示|教育|科普)|不构成(?:医疗|医学|诊疗)建议|"
    r"不能替代(?:医生|专业医生|专业医疗)(?:的)?(?:诊断|建议|诊疗))"
    r"(?:[，,](?:不构成(?:医疗|医学|诊疗)建议|不能替代(?:医生|专业医生)(?:的)?(?:诊断|建议|诊疗)))*[。.!！]?|"
    r"(?:This (?:demo|response|information)|These explanations) (?:is|are) "
    r"(?:for (?:educational|demonstration|informational) purposes only|not medical advice)[.!]?", re.I)


def concise_patient_text(text: str) -> str:
    clauses = re.split(r"(?<=[。！？])|\n+|(?<=[.!?])\s+", text or "")
    return " ".join(c.strip() for c in clauses if c.strip() and not IDENTITY_BOILERPLATE.fullmatch(c.strip()))


def personal_context_expected(question: str, history: list[dict]) -> bool:
    turns=[question]+[h['text'] for h in history[-6:] if h.get('role')=='user' and isinstance(h.get('text'),str)]
    return any(re.search(r"凌晨.{0,8}睡|(?:喝|吃).{0,10}后.{0,8}心慌|我.{0,10}(?:每天|最近|正在服用|一直服用|轮班|夜班)|\bI (?:work|sleep|take|feel|have been|often|usually|sometimes|drink)\b",s,re.I) for s in turns)


def ground_context_updates(updates: list[dict], sections: dict[str, str]) -> None:
    # The model chooses a response section, never authors a second account of its
    # actions. Project a short excerpt directly from the validated answer text.
    for update in updates:
        key=update.get('focusField','explanation')
        if not sections.get(key):key='explanation'
        text=sections[key].strip()
        first=re.split(r'(?<=[。！？])|(?<=[.!?])\s+',text)[0]
        update['focus']=first[:220]
        update['focusField']=key


def validate_context_updates(updates: list[dict], question: str, history: list[dict], sections: list[str] | None = None) -> None:
    # Quotes must come from individual real user turns, never report/assistant text.
    turns = [question] + [h['text'] for h in history[-6:]
                         if h.get('role') == 'user' and isinstance(h.get('text'), str)]
    seen = set()
    for update in updates:
        quote, focus = update['quote'].strip(), update['focus'].strip()
        if not quote or not focus or quote in seen or not any(quote in turn for turn in turns):
            raise ValueError('Context quote must be unique and copied exactly from a patient message')
        seen.add(quote)
        if sections is not None and not any(focus in text for text in sections):
            raise ValueError('Context focus must be an exact excerpt from this answer, not an invented action')
        validate_patient_wording(focus)
        validate_care_wording(focus)


class GuideAnswer(PatientCareFields):
    model_config = ConfigDict(extra="forbid")
    explanation: str = Field(min_length=1, max_length=1800)
    basis: str = Field(default="", max_length=700)
    limitation: str = Field(default="", max_length=900)
    understanding: Literal["not_checked", "consistent", "needs_clarification", "not_enough_information"]
    references: list[str] = Field(max_length=8)
    nextQuestion: str = Field(min_length=1, max_length=140)

    @field_validator("explanation", "nextQuestion")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Empty guide section")
        return value.strip()


# Legacy published notes and earlier assistant replies can contain expert-only
# benchmark comparisons. Filter every patient-model projection, not stored records.
RESEARCH_CLAUSE = re.compile(
    r"数据集标签|真值|\bGT\b|ground[ -]?truth|dataset.{0,20}label|"
    r"模型输出|model (?:output|prediction)|原始预测|(?:macro[ -]?)?F1|留出集|调整集", re.I)
TECHNICAL_PROSE = re.compile(r"\b(?:QRS|PR|qrs_duration_ms|pr_interval_ms|NORM|MI|STTC|CD|HYP)\b|\d+(?:\.\d+)?\s*(?:ms|mm|毫秒)", re.I)
TECHNICAL_QUESTION = re.compile(r"\b(?:QRS|PR)\b|数值|阈值|毫秒|测量值|\b(?:threshold|numeric|milliseconds?|value)\b", re.I)

# General definitions are separate from case evidence, never citation targets or
# evidence of an individual's symptoms, cause, severity, or treatment needs.
FINDING_EDUCATION = {
    "CD": "Conduction refers to the electrical signal coordinating the heartbeat. A conduction-related finding describes its timing or path; it is not the same as a blocked blood vessel and does not by itself establish how well the heart pumps.",
    "STTC": "ST/T refers to parts of the heart's electrical recovery after a beat. A change describes the tracing, not a single disease or a proven cause. Different findings on one tracing are not automatically separate illnesses.",
    "MI": "This is a pattern category associated with myocardial infarction (heart muscle injury from interrupted blood supply). This category alone does not establish that an infarction is occurring now, when it happened, or whether it is confirmed.",
    "HYP": "Hypertrophy means thickening of heart muscle. This ECG category describes electrical features associated with that possibility; an ECG category does not directly measure wall thickness.",
    "NORM": "The report assigns a normal ECG category. An ECG records electrical activity during the recording, not every aspect of heart health or symptoms outside that period.",
}


def general_education(report: dict) -> dict:
    return {"scope": "general_health_education_not_case_evidence",
            "findings": [{"label": label, "meaning": FINDING_EDUCATION[label]}
                         for label in report.get("labels", []) if label in FINDING_EDUCATION],
            "carePrinciples": [
                "Possible symptoms are general associations, never symptoms inferred from a report label. A person may have no symptoms. Ask about an actually reported symptom before tailoring an explanation.",
                "For ordinary rest questions offer practical low-risk habits: a regular sleep schedule, avoiding all-nighters, breaks when tired, and noting symptom timing/duration/activity. Do not prescribe bed rest, exercise intensity, fluid restriction or clearance for sport from an ECG category.",
                "Medication education may explain a named drug's usual purpose and common cautions. Do not choose, start, stop, change or dose a medicine for this person from this demo. A conduction finding, ST/T change or other category is not itself a reason to start aspirin, rate-slowing drugs or other heart medicines. Existing prescribed medicines remain governed by the person's prescriber.",
            ]}


def validate_care_wording(*sections: str) -> None:
    # Narrow guard for generated dose schedules, not a medical-fact verifier.
    if any(re.search(r"(?:每次|每日|每天|一次|一日|睡前|饭后|服用|take|start|increase|reduce).{0,24}\d+(?:\.\d+)?\s*(?:mg|mcg|毫克|微克|片|粒)|\d+(?:\.\d+)?\s*(?:mg|mcg|毫克|微克)\s*(?:/|per |a )(?:day|日|天)", s, re.I) for s in sections):
        raise ValueError("Patient education must not generate a medication dose or schedule")


def validate_followup_question(text: str) -> None:
    if len(re.findall(r'[?？]', text)) > 1:
        raise ValueError('followUpQuestion must ask ONE missing detail, not multiple intake questions')


def technical_requested(question: str, selected: str = "") -> bool:
    return selected.startswith('measurement:') or bool(TECHNICAL_QUESTION.search(question))


def everyday_terms(text: str, language: str) -> str:
    """Localize known abbreviations without changing authored clinical claims."""
    zh = language == 'zh'
    names = {'CD': ('传导相关提示','conduction-related finding'),
             'MI': ('心肌梗死相关模式','infarction-related pattern'),
             'STTC': ('心电恢复阶段变化','electrical recovery changes'),
             'HYP': ('心肌增厚相关模式','hypertrophy-related pattern'),
             'NORM': ('正常类别','normal category'),
             'QRS': ('心室电活动','ventricular electrical activity'),
             'PR': ('心房至心室传导','atrial-to-ventricular conduction')}
    return re.sub(r'\b(?:CD|MI|STTC|HYP|NORM|QRS|PR)\b',
                  lambda m:names[m.group().upper()][0 if zh else 1],text,flags=re.I)


def patient_prose(text: str) -> str:
    clauses = re.split(r"(?<=[。！？；;])|\n+|(?<=[.!?])\s+", text or "")
    return " ".join(c.strip() for c in clauses if c.strip() and not RESEARCH_CLAUSE.search(c))


def patient_model_report(report: dict) -> dict:
    text = patient_prose(report.get("note", ""))
    return dict(report, note=text, researchClausesOmitted=text != (report.get("note") or "").strip())


def validate_patient_wording(*sections: str, allow_technical: bool = True) -> None:
    if any(RESEARCH_CLAUSE.search(s) for s in sections):
        raise ValueError("Patient wording contains an expert-only research comparison")
    if not allow_technical and any(TECHNICAL_PROSE.search(s) for s in sections):
        raise ValueError("Unrequested technical detail in a plain-language answer")
    if any(re.search(r"没(?:有)?看(?:过)?(?:波形|心电图)|(?:波形|心电图)没(?:有)?看|你到底有没有病|(?:您|你)的心脏到底|阅读摘录|不是完整原件|reading excerpt|not the complete original",s,re.I) for s in sections):
        raise ValueError("Report limitation overstates what was not viewed")


def guide_materials(report: dict, *, technical: bool = True) -> list[dict]:
    """Allowlist the published snapshot; exclude expert hypotheses/cohort diagnostics."""
    text = patient_prose(report["note"])
    # Keep authored evidence intact for understanding. Plain-language rendering
    # is an output requirement, not a reason to erase informative report clauses.
    items = [{"id": "report", "kind": "published_report", "text": text,
              "labels": report["labels"], "revision": report["revision"],
              "technicalDescriptionsOmitted": text != patient_prose(report["note"]),
              "containsAuthoredMeasurementDescription": bool(re.search(r"\b(?:QRS|PR)\b|\d+(?:\.\d+)?\s*(?:ms|mm|毫秒)", patient_prose(report["note"]),re.I)),
              "systemGenerated": bool(report.get("patientReport"))}]
    for f in report.get("features", []):
        items.append({"id": "measurement:" + f["name"], "kind": "attached_measurement",
                      **{k: f[k] for k in ("name", "value", "unit") if k in f},
                      "warnings": [patient_prose(str(w)) for w in f.get("warnings", []) if patient_prose(str(w))],
                      "status": (f.get("judgment") or {}).get("status", f.get("status", "unknown"))})
    focus = (report.get("feedbackImpact") or {}).get("focus")
    if focus:
        items.append({"id": "change", "kind": "published_case_assessment_change",
                      "before": focus.get("before"), "after": focus.get("after"),
                      "scope": "case_local_demo_assessment_not_training_or_diagnosis"})
    return items


async def guide_patient(config: Any, *, report: dict, question: str, mode: str,
                        language: str, selected: str, history: list[dict], complete=None,
                        clarification: dict | None = None) -> dict:
    technical = technical_requested(question, selected)
    materials = guide_materials(report, technical=technical)
    if clarification:
        materials.append({"id": "clarification", "kind": clarification.get("kind", "published_expert_reviewed_demo_answer"),
                          "text": patient_prose(clarification["text"]), "reportRevision": clarification["reportRevision"],
                          "question": clarification.get("question", ""),
                          "unresolved": clarification["unresolved"], "change": clarification["change"],
                          "checks": clarification.get("checks", []),
                          "currentCheckAvailable": clarification.get("currentCheckAvailable", True)})
    ids = {m["id"] for m in materials}
    if selected and selected not in ids:
        raise PatientGuideInputError("Selected evidence is not attached to this published report.")
    if not question.strip():
        raise PatientGuideInputError("Write a question or your interpretation before sending.")
    if needs_urgent_guidance(question):
        zh = language == "zh"
        return {"explanation": "如果现在正在胸痛、明显呼吸困难，或刚发生晕厥，请立即联系当地急救服务寻求紧急医疗帮助，不要等在线报告解答。停止活动，在安全处坐下或躺下，尽量请身边的人陪同，不要自己开车。" if zh else
                "If chest pain or marked breathing difficulty is happening now, or you have just fainted, seek urgent help by contacting local emergency services now. Stop activity, sit or lie somewhere safe, ask someone to stay with you, and do not drive yourself.",
                "limitation": "" ,
                "understanding": "not_checked", "references": [], "nextQuestion": "",
                "source": "safety", "materials": materials}
    turns = [{"role": h["role"], "text": (patient_prose(h["text"]) if h["role"] == "assistant" else h["text"])[:2000]} for h in history[-6:]
             if h.get("role") in ("user", "assistant") and isinstance(h.get("text"), str)]
    context = patient_context(question, turns, report)
    data = {"question": question, "mode": mode, "language": language, "selectedMaterial": selected,
            "patientContext": context,
            "contextQuoteCandidates": context_quote_candidates(question, turns),
            "patientContextExpected": personal_context_expected(question, turns),
            "generalEducation": general_education(report),
            "publishedMaterials": materials, "conversation": turns, "technicalDetailRequested": technical,
            "materialFacts": {"publishedRevision": report["revision"],
                              "reportTextAvailable": bool(patient_prose(report["note"])),
                              "attachedMeasurementCount": len(report.get("features", [])),
                              "scope": "supplied_published_materials_only_no_waveform_analysis_or_rule_verification"}}
    for attempt in range(2):
        raw = await (complete or complete_json)(config, [
            {"role": "system", "content": prompt("patient-guide")},
            {"role": "user", "content": json.dumps(data, ensure_ascii=False)}])
        answer = raw
        try:
            answer = GuideAnswer.model_validate(raw).model_dump()
            for key in ('explanation','symptoms','dailyCare','medication','limitation'):
                answer[key] = concise_patient_text(answer[key])
            if not answer['explanation'].strip():
                raise ValueError('Answer must provide useful content, not identity boilerplate alone')
            if not technical:
                for key in ('explanation','symptoms','dailyCare','medication','basis','limitation','nextQuestion'):
                    answer[key] = everyday_terms(answer[key], language)
            if data['patientContextExpected'] and not answer['contextUpdates']:
                raise ValueError('Include contextUpdates for the actual personal context supplied by the patient')
            ground_context_updates(answer['contextUpdates'],
                {k:answer[k] for k in ('explanation','symptoms','dailyCare','medication','nextQuestion')})
            validate_context_updates(answer['contextUpdates'], question, turns,
                [answer[k] for k in ('explanation','symptoms','dailyCare','medication','nextQuestion')])
            validate_patient_wording(answer["explanation"], answer["limitation"], answer["nextQuestion"],allow_technical=technical)
            validate_patient_wording(answer['basis'])  # Exact authored numbers may live in the folded source receipt.
            validate_patient_wording(answer['symptoms'], answer['dailyCare'], answer['medication'],allow_technical=technical)
            validate_care_wording(answer['explanation'], answer['symptoms'], answer['dailyCare'], answer['medication'], answer['nextQuestion'])
            validate_patient_wording(answer['followUpQuestion'],allow_technical=technical)
            validate_care_wording(answer['followUpQuestion'])
            validate_followup_question(answer['followUpQuestion'])
            if mode == 'prepare' and data['patientContextExpected'] and not answer['followUpQuestion'].strip():
                raise ValueError('Ask one key missing question TO the patient in followUpQuestion, while answering now')
            if language == 'zh' and not technical and any(len(answer[k])>limit for k,limit in (('explanation',300),('basis',160),('limitation',90),('symptoms',180),('dailyCare',180),('medication',240))):
                raise ValueError('Everyday answer is too long')
            if re.search(r"^(?:我可以帮|我能帮|Would you like me|May I help)",answer['nextQuestion'],re.I):
                raise ValueError('Follow-up must be a question the patient can ask, not an Agent offer')
            if not set(answer["references"]) <= ids:
                raise ValueError('Guide referenced an unavailable material')
            if mode != 'teachback' and answer['understanding'] != 'not_checked':
                raise ValueError('understanding MUST be not_checked outside teachback')
            break
        except ValueError as exc:
            if attempt: raise
            data["previousAnswerToRewrite"] = answer
            data["wordingIssue"] = str(exc)
            data["responseCorrectionRequired"] = "Correct the supplied wordingIssue and previousAnswerToRewrite. understanding MUST be not_checked outside teachback. zh explanation<=300, basis<=160, limitation<=90, symptoms/dailyCare<=180, medication<=240. No numerical measurements in explanation/care/nextQuestion unless requested. Authored measurements, if needed, belong only in basis (folded receipt). No research comparisons or medication doses/schedules. Optional fields may be empty. nextQuestion is the PATIENT asking the Agent."
    if not set(answer["references"]) <= ids:
        raise ValueError("Guide referenced an unavailable material")
    if mode != "teachback" and answer["understanding"] != "not_checked":
        raise ValueError("Understanding check requires a patient paraphrase")
    answer["references"] = list(dict.fromkeys(answer["references"]))
    return dict(answer, source="llm", materials=materials, patientContext=context)
