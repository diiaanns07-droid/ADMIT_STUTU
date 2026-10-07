"""Метки классификатора — ровно ui/civic_feedback/service.py CATEGORIES (CODE_BASE_SHA 56538a3).

Правило разметки (LABELING_GUIDE.md): метку определяет объект проблемы, а не место.
Фонарь у остановки -> lighting; светофор и разметка «зебры» -> roads; пандус/бордюр -> sidewalks.
"""

LABELS = ("roads", "sidewalks", "transport_stops", "lighting", "landscaping", "other")
LABEL_TEXT_RU = {
    "roads": "Дороги",
    "sidewalks": "Тротуары и пешеходные пути",
    "transport_stops": "Остановки транспорта",
    "lighting": "Освещение",
    "landscaping": "Благоустройство и озеленение",
    "other": "Другое",
}
LANGUAGES = ("ru", "kk", "unknown")  # значения ui/civic_feedback/text.py detect_language
