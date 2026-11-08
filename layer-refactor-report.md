# Arena3 server layer refactor

Moved 60 files with git mv. Updated imports and path references only; no commit or push.

## Final src/server tree (two levels)

Every file inherits the layer shown on its directory. Nested handlers and fonts are listed immediately below the tree.

```text
src/server/
  app-data/  [App data (retained)]
    app-data.test.ts
    client.server.ts
    readiness.ts
    server-only.ts
  auth/  [Auth (retained)]
    email-password.ts
    gate-identity.server.ts
    gate-identity.test.ts
    gate-session.server.ts
    isolation.server.ts
    middleware.ts
    pglite-dialect.ts
    popup.server.ts
    preview.ts
    server.ts
    verify.server.ts
  controllers/  [Application / Controller]
    errors.ts
    flows.test.ts
    handlers/
    helpers.ts
    ratelimit.test.ts
    ratelimit.ts
    router.ts
    session.ts
    tx.test.ts
    tx.ts
    validate.ts
  data/  [Data Access]
    db.ts
    jobs.ts
    media-files.ts
    report-files.ts
  env.server.ts  [Server configuration, retained]
  integrations/  [External systems]
    bank.ts
    fonts/
    gemini.ts
    notify.ts
    payos.ts
    pdf.ts
  og/  [Brand metadata (retained)]
    site.json
  services/  [Business / Domain]
    arena3.test.ts
    catalog.ts
    checkin.ts
    columns.ts
    crypto.ts
    flags.ts
    membership.test.ts
    membership.ts
    money-words.ts
    phone.ts
    policy.ts
    pricing.ts
    promos.ts
    rrule.ts
    rules.ts
```

`controllers/handlers/` (all Application / Controller):

- `assets.ts`
- `attendance.ts`
- `auth.ts`
- `avatar.ts`
- `bookings.ts`
- `certificates.ts`
- `chat.ts`
- `checkin.ts`
- `classes.ts`
- `courts.ts`
- `desk.ts`
- `extras.ts`
- `google.ts`
- `live.ts`
- `members.ts`
- `online.ts`
- `ops.ts`
- `plans.ts`
- `promos.ts`
- `reports.ts`
- `sports.ts`
- `staff.ts`
- `training.ts`

`integrations/fonts/` (all External systems assets):

- `LICENSE.txt`
- `Roboto-Bold.ttf`
- `Roboto-Regular.ttf`

Shared business modules already used by the frontend (coaches, contracts, labels, time, translator) remain in `src/shared/arena3`. The Google Calendar URL helper remains in `src/client/arena3/gcal.ts`; there was no server gcal.ts. Avatar and media request handlers remain unchanged in controllers/handlers; avatar uploads use SQL storage.

## LAYER VIOLATIONS

Existing violations were preserved. Counts are syntactic call sites, not runtime query counts. SQL includes sql tagged templates, all .query/.exec calls, and calls to one/q that contain SQL in controllers; getSql acquisition sites are counted separately. Imports, comments, declarations, and SQL calls in services/data are excluded. Test code is listed separately.

Production controllers: **27 files, 721 sites**. Controller test files: **2 files, 398 sites**.

### Controllers running SQL or acquiring getSql

| File | Sites | Exact line numbers by operation |
|---|---:|---|
| `src/server/controllers/handlers/assets.ts` | 24 | **sql.query**: 118, 149, 189, 198, 206, 349, 393, 399, 441, 447, 458, 488, 530, 561, 580, 585, 593, 634, 657, 669, 689, 697, 735, 785 |
| `src/server/controllers/handlers/attendance.ts` | 11 | **sql.query**: 86, 215, 239, 263, 280, 292, 391; **one(sql, ...)**: 351, 354, 367, 383 |
| `src/server/controllers/handlers/auth.ts` | 40 | **one(sql, ...)**: 110, 128, 130, 131, 162, 193, 223, 254, 302, 308, 435, 441, 614; **sql.query**: 213, 219, 224, 225, 229, 265, 271, 274, 290, 335, 345, 350, 360, 373, 393, 401, 429, 454, 484, 494, 503, 511, 515, 579, 618, 625; **/^Bearer\s+(.+)$/i.exec**: 281 |
| `src/server/controllers/handlers/avatar.ts` | 4 | **sql.query**: 144, 167; **one(sql, ...)**: 189, 202 |
| `src/server/controllers/handlers/bookings.ts` | 69 | **one(sql, ...)**: 47, 116, 137, 337, 370, 403, 432, 482, 488, 505, 511, 535, 555, 591, 619, 666, 671, 704, 779, 842, 843, 882, 921, 957, 996, 1052, 1082, 1121, 1162, 1175, 1183, 1210, 1238, 1332, 1339, 1382, 1390, 1401, 1404, 1438, 1464, 1465, 1471; **sql.query**: 130, 156, 168, 210, 216, 232, 278, 289, 447, 504, 584, 682, 794, 800, 909, 1006, 1007, 1090, 1103, 1104, 1189, 1306, 1308, 1316, 1353, 1415 |
| `src/server/controllers/handlers/certificates.ts` | 10 | **sql.query**: 15, 29, 84, 132; **one(sql, ...)**: 50, 64, 77, 153, 163, 179 |
| `src/server/controllers/handlers/chat.ts` | 22 | **one(sql, ...)**: 40, 45, 62, 185, 212, 230, 275, 289, 300, 332, 404, 486; **sql.query**: 120, 244, 341, 414, 430, 432, 438, 447, 465, 495 |
| `src/server/controllers/handlers/checkin.ts` | 14 | **sql.query**: 48, 50, 52, 55, 80, 87, 168, 282; **one(sql, ...)**: 114, 120, 159, 292, 304, 323 |
| `src/server/controllers/handlers/classes.ts` | 98 | **sql.query**: 54, 169, 292, 298, 303, 308, 313, 317, 348, 364, 431, 440, 447, 449, 456, 464, 472, 531, 614, 637, 638, 675, 707, 713, 714, 722, 742, 743, 753, 773, 846, 858, 893, 945, 980, 981, 1037, 1042, 1047, 1116, 1125, 1126, 1131, 1133, 1143, 1169, 1236, 1243, 1252, 1276, 1281, 1282, 1286, 1290, 1300, 1315, 1324, 1329, 1337; **one(sql, ...)**: 141, 143, 150, 162, 184, 219, 243, 250, 253, 264, 293, 345, 384, 410, 433, 450, 468, 478, 483, 524, 576, 592, 594, 600, 624, 652, 681, 686, 695, 708, 728, 804, 884, 930, 1092, 1103, 1109, 1173, 1227 |
| `src/server/controllers/handlers/courts.ts` | 15 | **sql.query**: 12, 70, 184, 227, 261; **one(sql, ...)**: 56, 94, 112, 145, 161, 168, 234, 246, 268; **/^[A-Z]{2}-(\d+)$/.exec**: 76 |
| `src/server/controllers/handlers/desk.ts` | 81 | **one(sql, ...)**: 36, 42, 52, 63, 81, 93, 111, 117, 132, 168, 176, 191, 235, 251, 270, 281, 284, 290, 306, 313, 339, 375, 379, 423, 424, 435, 462, 481, 493, 503, 533, 575, 583, 603, 647, 659, 702, 859, 866, 908, 920, 947, 1077, 1181, 1191, 1197, 1207, 1231; **sql.query**: 89, 128, 140, 141, 142, 145, 146, 387, 598, 667, 726, 741, 768, 786, 818, 875, 896, 956, 1047, 1089, 1119, 1151, 1219, 1236, 1251, 1256, 1258, 1295, 1300, 1332, 1354, 1355, 1356 |
| `src/server/controllers/handlers/extras.ts` | 51 | **one(sql, ...)**: 38, 62, 93, 160, 163, 224, 274, 345, 357, 391, 433, 456, 591, 630, 665, 696, 699, 721, 724, 738, 860, 900; **sql.query**: 161, 169, 172, 175, 247, 268, 269, 328, 360, 376, 425, 462, 481, 519, 545, 593, 614, 633, 643, 651, 671, 673, 683, 749, 862, 892, 916, 923, 926 |
| `src/server/controllers/handlers/live.ts` | 7 | **one(sql, ...)**: 13, 25, 37, 50, 63, 72, 84 |
| `src/server/controllers/handlers/members.ts` | 20 | **sql.query**: 18, 112, 130, 139, 151, 195, 323, 377, 435; **one(sql, ...)**: 46, 62, 63, 83, 94, 102, 125, 174, 249, 310, 428 |
| `src/server/controllers/handlers/online.ts` | 22 | **one(sql, ...)**: 84, 102, 108, 129, 138, 154, 181, 222, 270, 289, 304, 314, 347, 378, 418, 494, 566; **sql.query**: 93, 453, 511, 593, 612 |
| `src/server/controllers/handlers/ops.ts` | 53 | **sql.query**: 67, 103, 146, 191, 198, 202, 209, 231, 265, 309, 354, 355, 359, 366, 392, 415, 493, 494, 526, 697, 713, 724, 738, 747, 891, 913, 1016; **one(sql, ...)**: 87, 108, 113, 121, 151, 156, 167, 169, 175, 213, 221, 246, 283, 298, 310, 322, 346, 472, 487, 676, 877, 902, 926, 948, 965, 1006 |
| `src/server/controllers/handlers/plans.ts` | 14 | **sql.query**: 14, 93, 187; **one(sql, ...)**: 47, 66, 73, 88, 103, 128, 146, 158, 166, 194, 197 |
| `src/server/controllers/handlers/promos.ts` | 14 | **sql.query**: 142, 223, 232; **one(sql, ...)**: 150, 153, 156, 169, 175, 193, 197, 225, 261, 273, 286 |
| `src/server/controllers/handlers/reports.ts` | 6 | **sql.query**: 52, 100, 228, 243; **one(sql, ...)**: 210, 242 |
| `src/server/controllers/handlers/sports.ts` | 26 | **sql.query**: 30, 45, 157, 166, 366, 368, 369, 370, 391; **one(sql, ...)**: 123, 129, 135, 187, 208, 213, 226, 245, 255, 267, 276, 288, 303, 318, 324, 339, 359 |
| `src/server/controllers/handlers/staff.ts` | 16 | **one(sql, ...)**: 86, 156, 163, 221; **q(sql, ...)**: 102, 130, 137; **sql.query**: 170, 173, 202, 232, 237, 239, 241, 252, 265 |
| `src/server/controllers/handlers/training.ts` | 61 | **one(sql, ...)**: 54, 75, 99, 118, 145, 211, 230, 264, 329, 368, 386, 451, 513, 543, 683, 752, 759, 768, 800, 835, 854, 891, 907, 921, 934, 936, 940, 953, 1002, 1019, 1023; **sql.query**: 146, 150, 156, 163, 172, 178, 195, 212, 291, 340, 343, 375, 389, 440, 459, 476, 496, 526, 544, 548, 568, 579, 587, 594, 713, 840, 878, 963, 991, 1027 |
| `src/server/controllers/helpers.ts` | 15 | **one(sql, ...)**: 56, 86, 133, 164, 255, 318, 424, 468, 485; **sql.query**: 118, 189, 279, 337, 441, 490 |
| `src/server/controllers/router.ts` | 13 | **getSql**: 56, 168, 173, 177, 182, 186, 190, 194, 198, 203, 207, 226, 746 |
| `src/server/controllers/session.ts` | 5 | **one(sql, ...)**: 43, 56, 92; **sql.query**: 68; **/^Bearer\s+(.+)$/i.exec**: 89 |
| `src/server/controllers/tx.ts` | 9 | **tx.query**: 71; **client.query**: 98, 100, 104, 109, 114, 124; **sql.query**: 136, 141 |
| `src/server/controllers/validate.ts` | 1 | **/^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec**: 155 |

The transaction implementation remains in controllers/tx.ts as requested; its driver and SQL-wrapper calls are included above. No sql tagged-template call sites were found in production controllers; SQL is expressed through query/exec and one/q.

### Controller tests running SQL

| File | Sites | Exact line numbers by operation |
|---|---:|---|
| `src/server/controllers/flows.test.ts` | 25 | **db.exec**: 37; **db.query**: 71, 81, 90, 95, 110, 126, 152, 159, 175, 203, 217, 220, 230, 250, 294, 322, 324, 367, 462, 479, 480, 499, 516, 590 |
| `src/server/controllers/tx.test.ts` | 373 | **db.exec**: 54; **db.query**: 65, 82, 87, 103, 109, 142, 167, 247, 344, 353, 360, 366, 458, 464, 473, 477, 487, 500, 530, 566, 571, 575, 636, 641, 668, 693, 698, 699, 707, 712, 734, 740, 745, 746, 752, 775, 780, 781, 787, 822, 828, 830, 878, 879, 907, 965, 972, 973, 974, 1067, 1078, 1086, 1087, 1088, 1101, 1108, 1109, 1130, 1142, 1154, 1156, 1161, 1170, 1174, 1175, 1176, 1183, 1193, 1194, 1197, 1200, 1203, 1208, 1210, 1211, 1212, 1224, 1230, 1235, 1242, 1251, 1252, 1253, 1261, 1262, 1263, 1265, 1272, 1284, 1313, 1321, 1539, 1541, 1630, 1638, 1645, 1698, 1702, 1711, 1717, 1724, 1733, 1740, 1778, 1781, 1790, 1799, 1805, 1812, 1875, 1876, 1877, 1880, 1887, 1895, 1901, 1907, 1916, 1922, 1931, 1937, 1976, 2000, 2041, 2060, 2096, 2097, 2105, 2149, 2161, 2175, 2176, 2177, 2179, 2188, 2200, 2203, 2221, 2230, 2250, 2277, 2290, 2306, 2307, 2314, 2331, 2339, 2346, 2355, 2371, 2384, 2394, 2410, 2420, 2506, 2507, 2508, 2509, 2530, 2649, 2698, 2710, 2716, 2718, 2736, 2737, 2738, 2739, 2740, 2741, 2743, 2752, 2759, 2777, 2782, 2794, 2797, 2802, 2812, 2823, 2829, 2837, 2841, 2848, 2852, 2853, 2854, 2871, 2882, 2887, 2892, 2897, 2898, 2899, 2917, 2918, 2919, 2920, 2921, 2922, 2923, 2929, 2935, 2940, 2946, 2951, 2957, 2965, 2970, 2975, 2981, 2992, 3102, 3103, 3104, 3105, 3111, 3117, 3122, 3127, 3206, 3213, 3277, 3283, 3290, 3301, 3310, 3317, 3338, 3345, 3346, 3369, 3376, 3442, 3464, 3477, 3491, 3510, 3530, 3536, 3537, 3549, 3551, 3561, 3569, 3571, 3575, 3579, 3604, 3621, 3649, 3655, 3698, 3717, 3720, 3722, 3737, 3748, 3749, 3750, 3752, 3755, 3757, 3766, 3767, 3769, 3789, 3791, 3801, 3803, 3812, 3819, 3863, 3869, 3882, 3884, 3886, 3908, 3910, 3916, 3929, 3930, 3940, 3942, 3953, 3955, 3959, 3965, 3972, 3979, 3993, 3995, 4017, 4048, 4080, 4098, 4117, 4125, 4133, 4140, 4145, 4152, 4165, 4168, 4171, 4209, 4211, 4214, 4221, 4257, 4263, 4270, 4277, 4278, 4280, 4284, 4294, 4296, 4302, 4313, 4316, 4329, 4337, 4350, 4374, 4391, 4397, 4423, 4434, 4447, 4448, 4449, 4454, 4465, 4471, 4498, 4511, 4513, 4556, 4563, 4573, 4575, 4591, 4616, 4620, 4628, 4637, 4680, 4685, 4697, 4700, 4703, 4716, 4726, 4734, 4744, 4751, 4838, 4849, 4865, 4900, 4907, 4928, 4944, 4970, 4980, 5063; **sql.query**: 71, 93, 3900, 3933, 4202 |

### Services importing controllers

**9 production imports across 6 files; 2 test imports.** No type-only imports in this list.

| File:line | Import target | Kind |
|---|---|---|
| `src/server/services/arena3.test.ts:7` | `../controllers/errors.ts` | test |
| `src/server/services/arena3.test.ts:8` | `../controllers/validate.ts` | test |
| `src/server/services/checkin.ts:18` | `../controllers/errors.ts` | production |
| `src/server/services/flags.ts:2` | `../controllers/errors` | production |
| `src/server/services/flags.ts:3` | `../controllers/tx` | production |
| `src/server/services/membership.ts:2` | `../controllers/errors` | production |
| `src/server/services/membership.ts:4` | `../controllers/tx` | production |
| `src/server/services/policy.ts:2` | `../controllers/errors` | production |
| `src/server/services/pricing.ts:2` | `../controllers/errors` | production |
| `src/server/services/promos.ts:11` | `../controllers/errors` | production |
| `src/server/services/promos.ts:13` | `../controllers/tx` | production |

## Verification

| Command/check | Status |
|---|---|
| npx tsc --noEmit | PASS (npx.cmd on Windows), exit 0 |
| node scripts/with-app-env.mjs vite build | PASS, exit 0; local node_modules/.bin added to PATH |
| npm test | PASS (npm.cmd on Windows), exit 0; 139 + 158 = 297 TypeScript tests |
| Search src/, scripts/, vite.config.ts, package.json, tsconfig.json, eslint.config.mjs for removed server/api references | PASS, zero references; excluded protected graphify-out |
| AST comparison with pre-refactor snapshot | PASS, no changes beyond imports/path literals and comments |
| Protected files byte comparison | PASS, all 1,809 existing files unchanged |

ESLint config was inspected and required no path updates. The @/ alias is unchanged. src/server/api no longer exists. Tests moved alongside their tested layer: business tests in services, transaction/rate-limit/HTTP-flow tests in controllers.

### Existing script-test caveat

On this Windows environment, the existing quoted glob in npm test (`node --test 'scripts/**/*.test.mjs'`) discovers zero script tests. The npm test command passes but does not exercise that phase. The glob and runner logic were left unchanged under the pure path-refactor scope.

An additional explicit run of all 10 script test files executes 197 tests: 177 pass and 20 fail. A temporary copy of the pre-refactor snapshot produces the same 197/177/20 result and the same failure titles. No new script-test failures were introduced. Existing failures concern absent .grok template skill/config files, symlink/Windows shell behavior, template auth/migration expectations, and branding expectations.

Pre-existing failing script tests:

- `scripts\brand-check.test.mjs:308:1`: SKILL.md and AGENTS.md name the marker path and bound this script uses
- `scripts\brand-check.test.mjs:346:1`: the sections that own the brand-task prohibition never affirm a wait
- `scripts\brand-check.test.mjs:365:1`: SKILL.md tells the pass to self-check with the flag this CLI accepts
- `scripts\check-auth-invariant.test.mjs:93:1`: the build side resolves the template's shipped app-env
- `scripts\check-auth-invariant.test.mjs:98:1`: the CLI reports rather than silently passing when run via a symlink
- `scripts\grok-pwa-plugin.test.mjs:105:1`: platform chrome overwrites share-card metas and always sets og:title
- `scripts\grok-pwa-plugin.test.mjs:246:1`: published grok.me slug is still a title fallback
- `scripts\grok-pwa-plugin.test.mjs:305:1`: emits og:image for a public host and prefers a custom card
- `scripts\grok-pwa-plugin.test.mjs:326:1`: placeholder og:image appends site.color when it is 6-digit hex
- `scripts\grok-pwa-plugin.test.mjs:349:1`: document title entities are not double-escaped on og:title
- `scripts\grok-pwa-plugin.test.mjs:365:1`: injects into documents with no head element
- `scripts\grok-pwa-plugin.test.mjs:372:1`: streaming injector matches </HEAD> case-insensitively
- `scripts\grok-pwa-plugin.test.mjs:397:1`: uses the app name in the injected title tag
- `scripts\migration-plan.test.mjs:59:1`: the auth schema ships outside the globbed directory
- `scripts\with-app-env.test.mjs:62:1`: the template ships auth off
- `scripts\with-app-env.test.mjs:76:1`: the wrapped command runs with the app env applied
- `scripts\with-app-env.test.mjs:86:1`: the wrapped command sees an explicit override, not the file value
- `scripts\with-app-env.test.mjs:95:1`: the wrapper propagates the command's exit code
- `scripts\with-app-env.test.mjs:116:1`: the CLI still runs when invoked through a symlinked path
- `scripts\write-atomic.test.mjs:167:1`: every hand-over the og skill prints is one this script accepts
