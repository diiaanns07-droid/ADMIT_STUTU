# 02_HANDOFF.txt
- API_VERSION=ASHEN_V1
- files: 4
  - vision.js: 1592 lines; exports: API_VERSION, MEDIAPIPE_VERSION, DEFAULT_MEDIAPIPE, LANDMARK, COMPACT_INDICES, COMPACT_STRIDE, DEFAULT_VISION_CONFIG, mergeVisionConfig, unpackCompactLandmarks, createPoseInterpreter, resolveMediaPipe, mapCameraError, createVision
  - vision-worker.js: 192 lines
  - vision.test.mjs: 1239 lines; exports: FilesetResolver, PoseLandmarker
  - vision-webcam-check.html: 188 lines
  ! vision.js: possible truncation marker
  ! vision.test.mjs: possible truncation marker

# 03_HANDOFF.txt
- API_VERSION=ASHEN_V1
- files: 2
  - world.js: 2561 lines; exports: API_VERSION, createWorld
  - test_world.html: 237 lines
  (no problems detected)

# 04_HANDOFF.txt
- API_VERSION=ASHEN_V1
- files: 2
  - combat.js: 1079 lines; exports: COMBAT_API_VERSION, DEFAULT_COMBAT_CONFIG, sweptCylinderHit, createCombat
  - combat.test.js: 755 lines; exports: runCombatTests
  ! combat.js: possible truncation marker

# 05_HANDOFF.txt
- API_VERSION=ASHEN_V1
- files: 3
  - boss.js: 617 lines; exports: BOSS_API_VERSION, BOSS_TIME_EPSILON, DEFAULT_BOSS_CONFIG, createBossBrain, describeBossBalance
  - boss.test.js: 501 lines; exports: runBossTests
  - boss.test.html: 29 lines
  (no problems detected)

# 06_HANDOFF.txt
- API_VERSION=ASHEN_V1
- files: 2
  - effects.js: 2518 lines; exports: API_VERSION, createEffects
  - effects_testbench.html: 230 lines
  (no problems detected)

# 07_HANDOFF.txt
- API_VERSION=ASHEN_V1
- files: 5
  - ui.js: 1883 lines; exports: API_VERSION, createUI
  - ui.css: 1862 lines
  - ui-fixtures.js: 200 lines; exports: API_VERSION, DEFAULT_SETTINGS, makeSnapshot, FIXTURES, FIXTURE_NAMES, fixture
  - ui-selftest.js: 537 lines; exports: API_VERSION, runUISelfTest
  - ui-preview.html: 334 lines
  (no problems detected)
