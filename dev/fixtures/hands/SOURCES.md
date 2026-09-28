# Фикстуры рук — источники

`hagrid_images.json` — координаты (landmarks) кистей, извлечённые настоящим MediaPipe
HandLandmarker 0.10.35 (float16/1, режим IMAGE, CPU) из 179 изображений датасета
**HaGRID — HAnd Gesture Recognition Image Dataset** (Kapitanov, Kvanchiani, Nagaev, Kraynov,
Makhliarchuk; SberDevices), лицензия **CC BY-SA 4.0**, https://github.com/hukenovs/hagrid.
Изображения взяты из выборки `cj-mills/hagrid-classification-512p-no-gesture-150k`
(Hugging Face) через datasets-server; классы fist, palm, stop, one, ok, peace, like, no_gesture.

В проекте хранятся **только числа** (координаты точек кисти и запястий позы), сами фотографии
людей не распространяются. Метки: fist→fist, palm/stop→open, one→point, ok→pinch,
peace→victory, like→thumb, no_gesture→neutral.
