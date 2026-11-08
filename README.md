# WAR OF CARDS — ఫైనల్ డిజైన్ ప్రాజెక్ట్

ఈ ZIP ఒక ప్రత్యేక **WAR OF CARDS** ప్రాజెక్ట్. ఇప్పటికే ఉన్న TSB / Kreeda Lokam ఫైళ్లను దీనితో మార్చకండి. కొత్త ఫోల్డర్‌లో extract చేయండి.

## మొదట రన్ చేయడం

1. కంప్యూటర్‌లో **Node.js 24.x** ఇన్‌స్టాల్ చేసి ఉండాలి. [Official Node.js download](https://nodejs.org/en/download).
2. ZIP extract చేసి, `play-rummy` ఫోల్డర్‌ను VS Codeలో తెరవండి.
3. ఆ ఫోల్డర్ టెర్మినల్‌లో:

```bash
npm run setup
npm start
```

`setup` మీకోసం కొత్త Admin password తయారు చేసి టెర్మినల్‌లో చూపిస్తుంది. దాన్ని భద్రపరుచుకోండి. ముందే `.env` ఉంటే దాన్ని మార్చదు. Database మొదటిసారి తయారయ్యేటప్పుడు మాత్రమే ఈ credentialsతో admin create అవుతుంది.

| పేజీ | స్థానిక లింక్ |
|---|---|
| Customer | http://localhost:3000/ |
| Admin | http://localhost:3000/admin |

**Admin ID: `owner`**. Password: మీ కంప్యూటర్‌లో `npm run setup` చూపించినది. ఈ ZIPలో ముందే నిర్ణయించిన admin password లేదా customer accounts లేవు.

బయటి packages అవసరం లేదు; `npm install` అవసరం లేదు. Node.js built-in HTTP, crypto, SQLite ఉపయోగించాం. Frontend HTML/CSS/JavaScript; ఈ ప్రాజెక్ట్ React/Vite ఆధారితం కాదు.

## ముందుగా Adminలో చేయాల్సినవి

1. Payment Settingsలో బ్యాంక్, UPI, QR, support నంబర్ ఇవ్వండి.
2. Bonus Settingsలో శాతాలు / promo code పరిశీలించండి. ప్రారంభ కోడ్ `PLAY10`.
3. Sign Up Requestsలో వచ్చిన రిక్వెస్ట్‌కు **Create & Send ID** నొక్కండి.
4. Customer page అదే browserలో తెరిచి ఉంటే request boxలో **Reveal login details once** వస్తుంది.
5. Customer మొదటిసారి login అయ్యాక తప్పనిసరిగా password మార్చాలి.
6. Customers / IDsలో నేరుగా ID సృష్టించవచ్చు. Coin Managementలో కారణంతో balance add/remove చేయవచ్చు.

## సిద్ధమైన కస్టమర్ ఫ్లో

- Before Login: WAR OF CARDS / Play Rummy, Win Money, Log In, Sign Up, Welcome 10%, Promo 10%, Losing 10%.
- Losing card బయట 10% మాత్రమే. లోపల ₹10,000 net settled lossesకి ₹1,000 వివరాలు.
- Sign Up websiteలోనే జరుగుతుంది; WhatsApp తెరవదు.
- Userకి ప్రత్యేక, రహస్య request cookie ఉంటుంది. వారి ID / temporary password అదే request boxలో మాత్రమే వస్తాయి. Name ఆధారంగా replies match చేయము.
- Temporary password databaseలో encryptedగా ఉంటుంది; reveal చేసిన తర్వాత delivery తొలగుతుంది. Password hashes మాత్రమే user recordలో నిల్వ ఉంటాయి.
- Signup request browser cookie ఏడు రోజులు ఉంటుంది. Cookie తొలగిస్తే పాత request box మళ్లీ గుర్తించలేం; adminని సంప్రదించి password reset చేయించాలి.
- After Login నేరుగా tables lobby. My Games, Wallet, Support, Rules, Bonus info, Change Password, Logout.

## టేబుల్స్ — ఫైనల్ అమరిక

పైన నాలుగు tabs: **Point Rummy 101**, **Point Rummy 201**, **Pool Rummy**, **Deal Rummy**.

ప్రతి tabలో 80 tables; నాలుగింటికి కలిపి 320 table definitions. ఖాళీ tablesలో ఆటలు ప్రారంభం కావు.

| Entry | 2 Players | 6 Players | మొత్తం |
|---|---|---|---:|
| ₹10 | T1–T5 | T1–T5 | 10 |
| ₹20 | T1–T5 | T1–T5 | 10 |
| ₹50 | T1–T5 | T1–T5 | 10 |
| ₹100 | T1–T5 | T1–T5 | 10 |
| ₹250 | T1–T5 | T1–T5 | 10 |
| ₹500 | T1–T5 | T1–T5 | 10 |
| ₹1,000 | T1–T5 | T1–T5 | 10 |
| ₹2,000 | T1–T5 | T1–T5 | 10 |

ఫైనల్ screenshotలో ఉన్నట్టుగా compact white boxes, ఒక్కో capacityకి ఒక rowలో ఐదు buttons. Screen height బట్టి మిగతా amounts కోసం scroll. రెండు capacitiesలో T1 నుంచి numbering మొదలవుతుంది; లోపల IDsకి mode/stake/capacity కూడా ఉంటాయి కాబట్టి clash కాదు.

## గేమ్ ప్రారంభం / కంప్యూటర్ ప్లేయర్లు

- మొదటి human చేరినప్పుడు మాత్రమే countdown మొదలు.
- 2-player table: మొత్తం 15 seconds. తొలి 10 secondsలో human join చేయవచ్చు. 10 seconds తర్వాత ఖాళీ seatకి computer. 15 secondsకి deal.
- 6-player table: మొత్తం 30 seconds. తొలి 25 seconds human join window. ఆ తర్వాత ఖాళీ seats కంప్యూటర్లతో నింపి 30 secondsకి deal.
- 2,000 వేర్వేరు synthetic Indian-style names: 100 first names × 20 surnames. మగ / ఆడ పేర్లు కలిపి ఉన్నాయి. ఇవి నిజమైన customer accounts కాదు; వ్యక్తుల profile data సేకరించలేదు.
- ప్రతి computer seatపై **Computer** గుర్తు ఉంటుంది. Computerకి తన hand మాత్రమే ఆధారంగా move selection; గెలుపు ముందే fix చేయలేదు.
- Human వచ్చేవరకు computers తమంతట తామే కొత్త game మొదలుపెట్టవు.
- Human waitingలో leave అయితే entry debit కాదు. చివరి human leave అయితే waiting room మూసివేస్తాం.

## ఆట నియమాల అమలు

- 13 cards, రెండు standard decks + నాలుగు printed jokers.
- Draw → Discard; valid hand ఉంటే automatic declaration. Declare / Showలో తప్పు hand submit చేస్తే వెంటనే **80 points** cumulative scoreకు యాడ్ అవుతాయి. ఆ player అదే roundలో కొనసాగుతాడు; drop / out చేయము. Cards, turn, timer అలాగే ఉంటాయి. ఇది ₹80 wallet debit కాదు. సాధారణ discardకు ఈ penalty లేదు. Wrong declaration తర్వాత సరైన discard లేదా మరో declaration చేయవచ్చు. ప్రతి కొత్త తప్పు attemptకి 80; అదే request IDని replay చేస్తే మళ్లీ penalty ఉండదు.
- పూర్తి 13 cards groupsలో ఉండాలి; కనీసం రెండు sequences, వాటిలో ఒక pure sequence.
- Same-suit sequences, same-rank different-suit sets, printed/wild jokers, Ace low లేదా high; K–A–2 wrapping లేదు.
- Wild rank తన సహజ స్థానంలో pure sequenceలో ఉపయోగించవచ్చు.
- Discard pile నుంచి joker తీసుకోలేరు. Discard నుంచి తీసుకున్న అదే cardను ఆ turnలో వెనక్కి discard చేయలేరు.
- ప్రతి turn 30 seconds; timeout అయితే draw + auto-discard.
- Drop: table మొదటి turnకు ముందు 20 points; ఆ తర్వాత 40. ప్రతి hand deadwood cap 80.
- **మీరు కోరిన lobby పేర్లనే ఉంచాం:** Point Rummy 101 / 201 tabsలో 101 / 201 cumulative elimination series వాడాం. Pool default 101. Deal Rummy రెండు deals; తక్కువ total points గెలుపు. ఇది traditional per-point cash settlement కాదు.
- Dealsలో lowest-score tie అయితే human entries తిరిగి జమ. గేమ్ roundకి 200 turns దాటితే పూర్తి game drawగా entries refund.
- 101 / 201 series మధ్యలో round results 8 seconds చూపించి తదుపరి deal.
- ఒక accountకు ఒక active game. Seriesలో eliminated అయిన player final result వరకు అదే gameకి సంబంధించినవాడిగా ఉంటుంది.

## Wallet లెక్కలు

అమౌంట్లు databaseలో integer paiseగా నిల్వ ఉంటాయి. Frontend amountతో balance మార్చలేరు.

| సంఘటన | ₹100 entry ఉదాహరణ |
|---|---:|
| Game మొదలయ్యేటప్పుడు debit | −₹100 |
| Game series / deals winnerకి credit | +₹180 |
| Winner నికర లాభం | ₹80 |
| Loser నికర loss | ₹100 |
| Cancel / draw refund | +₹100 |

6-player tableలో కూడా winnerకి తన entryకి **1.8× fixed payout** మాత్రమే; అందరి stakes కలిపిన prize pool కాదు. మధ్యలో ప్రతి roundకి మళ్లీ stake debit / payout జరగదు.

Deposit: amount + proof PNG/JPEG (max 2 MB) + UTR → pending → Admin Approve/Reject. Approved deposit మాత్రమే balanceకి జమ. ఒకే UTRని మళ్లీ submit చేయలేరు.

Withdrawal: holder / bank / account / confirm account / IFSC / login password → amount hold → Admin Approve/Reject. Reject అయితే hold తిరిగి జమ. Approve అయితే wallet నుంచి ఇప్పటికే hold అయిన amountపై మళ్లీ debit లేదు. Minimum deposit ₹100, withdrawal ₹300; admin settingsలో మార్చవచ్చు.

**Bank / UPI transfer స్వయంగా జరగదు.** Admin bank payment విడిగా చేసి withdrawal decision నమోదు చేయాలి. ఈ softwareలో bank, payment gateway లేదా payout provider కనెక్షన్ లేదు. స్థానిక wallet records మాత్రమే నిర్వహిస్తుంది.

## బోనస్‌లకు ఈ వెర్షన్‌లో ఎంచుకున్న విధానం

ఈ లెక్కల కాలవ్యవధి / deposit basis పూర్తిగా నిర్ధారించలేదు కాబట్టి స్పష్టమైన ప్రారంభ defaults పెట్టాం:

- Welcome: మొదటి approved depositపై 10%, accountకి ఒక్కసారి.
- Promo: deposit requestలో సరైన promo code ఇచ్చినప్పుడు 10%, accountకి ఒక్కసారి.
- రెండు conditions సరిపోతే ఒక depositపై రెండూ రావచ్చు.
- Losing: జీవితకాల cumulative **net settled loss progress**. Loss పెంచుతుంది; game profit progress తగ్గిస్తుంది, zero కిందకి పోదు. ₹10,000 చేరితే user claim చేయవచ్చు; 10% = ₹1,000. Claim ఒక్క threshold consume చేస్తుంది. మళ్లీ ₹10,000 progress ఏర్పడితే మళ్లీ eligible.
- Bonuses walletకి నేరుగా credit అవుతాయి. వేరే bonus wallet / wagering restrictions ఈ వెర్షన్‌లో లేవు.

ఈ defaultsను launch ముందు మీ business rules ప్రకారం పరిశీలించండి. శాతాలు, threshold, promo code Adminలో మార్చవచ్చు.

## అడ్మిన్‌లో ఉన్నవి

Overview, Sign Up Requests, Customers / IDs, Deposit Requests, Withdrawals, Coin Management, Payment Settings, Bonus Settings, Games / Tables, Transactions, Admin Settings / Audit Log.

Block / unblock, reset password, revoke sessions, table pause / resume, active game cancel & refund ఉన్నాయి. Wallet operationsకు audit ఉంది; duplicate request decision రెండుసార్లు credit/refund చేయదు.

## స్క్రీన్ రొటేషన్

Website / lobby portraitలో responsiveగా ఉంటాయి. Table open చేస్తే portrait phoneలో table containerను landscapeగా చూపించే CSS fallback ఉంది. Rotate button fullscreen + orientation lockను browser అనుమతిస్తే వాడుతుంది; లేకపోతే local rotated view. Phone అడ్డంగా తిప్పితే native landscape layout. అన్ని browsers OS orientation lockకి అనుమతించవు.

## ఇంకా కనెక్ట్ చేయనివి

- **Automatic WhatsApp notifications:** అమలు చేయలేదు. Signup request Admin Panelకి, reply customer boxకి పనిచేస్తాయి. Official WhatsApp account/API/eligibility configuration ఇంకా అవసరం. ఎటువంటి WhatsApp సందేశాలు ఈ app పంపదు.
- Bank transfer, live payment gateway / payout provider, OTP / SMS లేవు.
- ఈ build ఒక single-server code release. High-concurrency load / external security audit / all-phone testing పూర్తికాలేదు.

## డేటా / హోస్టింగ్

`data/play-rummy.sqlite`, WAL/SHM files, `data/delivery.key` మరియు `.env` private. Public folder బయట ఉంటాయి. Databaseతో పాటు `delivery.key` కూడా backup చేయాలి; అది పోతే ఇంకా reveal చేయని signup passwords decrypt కావు. Runtime files ZIPలో లేవు.

Local installకు SQLite సరిపోతుంది. Render లేదా ఇతర hostలో **persistent disk**కి DATA_DIR ఇవ్వాలి; తాత్కాలిక filesystemపై production customer data నిల్వ చేయకండి. ఒక instance మాత్రమే run చేయండి; multi-instance matchmaking ఈ codeలో లేదు.

Deployment environment: Node 24.x, start `npm start`, persistent `DATA_DIR`, strong `ADMIN_ID` / `ADMIN_PASSWORD` before first start. HTTPS reverse proxy మీ నియంత్రణలో ఉంటే `TRUST_PROXY=true`; `NODE_ENV=production`. Copy `.env.example` only as a reference; secretsని repositoryలో commit చేయకండి. మీ existing TSB PostgreSQLకి ఈ project connect కాదు; ఇది వేరే SQLite database.

## పరీక్షలు

```bash
npm run check
npm test
```

Tests isolate their own temporary database. They cover table counts / labels, 2,000 names, deck integrity, meld validation, private hands, timers, two deals, signup delivery isolation, password gate, admin authorization, wallet decisions / replay protection, withdrawal hold/refund, paused tables, labelled bot admission, stake debit, cancellation refund, persistence, CSRF checks, and ₹100 → ₹180 winning settlement through the normal Declare endpoint.

ఈ వెర్షన్‌లో browser QA scopeను VALIDATION.mdలో చూడండి. Physical-phone rotation మరియు live multi-user load verification పూర్తికాలేదు.

## Full-file copy–paste

ఈ ZIPలో ఉన్న `War_Of_Cards_Copy_Paste.md`లో ప్రతి source file పూర్తి code ఉంటుంది. కొత్త file సృష్టించండి; లేదా ఆ projectలో అదే file ఇప్పటికే ఉంటే **పాత content మొత్తం Delete → పూర్తి code Copy → Paste → Save**. మధ్యలో చిన్న snippets కలపవద్దు.

Sources used for implementation reference: [Node 24 SQLite](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html). Indian-name usage checked via [Behind the Name](https://www.behindthename.com/support/usage.php?code=ind); the name combinations in this project were generated synthetically, not copied customer identities.

## ఫైనల్ విజువల్ లాక్ (8 November 2026)

- Site name: **WAR OF CARDS**. Caption: **Play Rummy, Win Money**.
- Before Login: final gold Ace / purple mounted-warriors logo, black background, gold accents, blue/purple bonus/game cards. Requested artwork line: “WORLD’S FIRST GAME”; ఇది supplied marketing copy మాత్రమే, independent first-in-world verification చేయలేదు.
- After Login: అదే compact logo; **plain purple + maroon** controls, white compact table containers, black background. Gold UI borders లేవు; gold logoలో మాత్రమే ఉంటుంది. Boxes ఒకే row arrangementలో; capacities రెండింటికీ numbering T1–T5 (imageలో ఉన్న T6–T10 label పాతది).
- In Game: landscape charcoal oval table, maroon rail, purple outlines, 2 లేదా 6 seats, private hand, Sort / Drop / Discard / Declare. Computer seatsపై గుర్తు.
- Wrong Declare: **+80 score points immediately, player continues in SAME round**. Series thresholdsను round result వచ్చినప్పుడు మాత్రమే apply చేస్తాం. A score penalty itself never drops or skips the player.

కొత్త logo asset `public/assets/brand-logo.png` ZIPలో ఉంది. Manual copy–pasteలో ఆ image fileను కూడా అదే pathలో ఉంచాలి.

## Tournament extension — Version 1.2.0

My Games / Wallet మధ్యలో glowing **Tournament** button ఉంది. Today / Tomorrow booking, రోజుకు IST 06:00 / 09:00 / 12:00 / 15:00 / 18:00 / 21:00, ప్రతి సమయానికి మూడు profiles. Full prize tables, provisional lower-rank prizes, initial 3-round format, admin prize-reserve opening and operational limits కోసం **TOURNAMENTS.md** చదవండి. `npm test`: 18 passed.

ఇప్పటికే install చేసి ఉంటే: మీ private `data/` directory, `delivery.key`, `.env` backup ఉంచండి. ఆ మూడు overwrite చేయకుండా ఈ ZIPలోని source files మొత్తాన్ని replace చేయండి. Database tables మొదటి startupలో స్వయంగా add అవుతాయి. కొత్త install అయితే `npm run setup` తర్వాత `npm start`.
