# WAR OF CARDS 1.2.0 — Tournament setup

## Final navigation

Home → My Games → **Tournament** → Wallet → Support.

Only Tournament has a slow neon/radium glow. Reduced-motion browser settings stop its animation. Existing lobby boxes retain their plain purple/maroon design.

## Daily schedule (Asia/Kolkata / IST)

Six start times: **06:00, 09:00, 12:00, 15:00, 18:00, 21:00**.

All THREE profiles start together at every time: **18 tournament instances per day**. Today and tomorrow are visible. Tomorrow's events can be booked today once the admin reserves their prize pool and opens registration.

Human registration and cancellation close **exactly 10 minutes before start**. Example: 06:00 start → 05:50 cutoff. At cutoff remaining seats are filled by labelled Computers; cards are dealt at the scheduled start. One customer can book only one profile at a given start time.

## Prize defaults

| Profile | Entry | Players | 1st | 2nd | 3rd | 4th | 5th–10th | Total prizes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Classic 100 | ₹1,000 | 100 | ₹50,000 | ₹25,000 | ₹10,000 | ₹5,000 | ₹1,000 each | ₹96,000 |
| Mega 1000 | ₹1,000 | 1,000 | ₹5,00,000 | ₹2,50,000 | ₹1,00,000 | ₹10,000 | ₹10,000 each | ₹9,20,000 |
| Starter 100 | ₹100 | 100 | ₹5,000 | ₹2,500 | ₹1,000 | ₹100 | ₹100 each | ₹9,200 |

**Classic 100 ranks 5–10 at ₹1,000 each is a provisional default** because the exact lower-rank breakdown was not confirmed. Admin can change all ten prizes before an event opens. Once registration is open, its published fee, capacity, format and prizes stay frozen.

## Match format defaults

The requested registration and prize plan did not define a knockout progression. This version uses **3 timed scoring rounds**, each up to **8 minutes**. These are explicit initial defaults; admin can choose 1–5 rounds and 1–20 minutes per round on unopened events.

- Each participant plays one 13-card table per round; tables contain 2–6 players, never a one-player bye at configured capacities.
- Players are randomly shuffled across tables at each round.
- Everyone stays in the event for all configured rounds; this is a scoring league, not a knockout bracket.
- A valid declaration finishes that table's hand. The declarer scores 0 deadwood; other players receive their hand/drop points.
- If time expires or 200 turns are reached, remaining hand points are recorded. If a player has drawn a 14th card, the final drawn card is excluded from timeout hand scoring.
- Wrong Declare / Show adds **80 points immediately** and the player continues the same hand, with their turn and cards intact.
- Lowest total points after all rounds ranks first. Tied players share the combined prizes for the affected rank positions. A tie spanning rank 10 can therefore produce more than ten paid people; total payout stays within the published pool.
- Tournament prizes follow this prize table. The regular game **1.8× payout does not apply** to tournament hands.
- A completed table's screen links back to the tournament, where the next table appears after all tables in that round finish. Rejoin through Tournament → My Booking / Enter → Enter My Table.
- Finish ordinary games before the scheduled tournament start; booked tournament seats auto-start even if the browser is closed. Turn timeouts still apply.

## Computer seats and funding

The name pool now has **2,000 unique synthetic Indian-style names** (100 first names × 20 surnames). They are names for Computer seats, not real accounts. Computer seats are labelled in the lobby, leaderboard and table; computer-vs-computer hands use the same dealt-card engine, with a lightweight strategy based only on their own cards. Prize rankings are computed from match scores, not assigned by admin.

**Computers do not contribute paid entry fees.** Before opening an event, Admin → Tournaments must reserve its full prize pool from the tournament prize reserve. This avoids treating invented computer fees as funds for real players' prizes.

1. Admin → Tournaments → Reserve adjustment: add the intended backing amount with a reason. This records an internal wallet adjustment; it does not debit a bank account.
2. Click **Reserve & Open** for each event to be offered. Booking is unavailable until its prize pool has been reserved.
3. A human booking debits their entry once. Cancellation before cutoff restores it once; rebooking creates a fresh booking.
4. At completion, human prizes are credited once from that reserved pool. Computer awards are not paid to fake wallets. Unused reserve and collected human entries return to the operator's tournament reserve ledger.
5. Admin event cancellation refunds human entries and releases the reserve. Empty events with no human registrations are cancelled instead of running all-computer prize events.

Existing pending human entry holds remain refundable; the admin's free reserve balance cannot withdraw money already held for an opened event. Reserve changes, event opening and cancellation are audited.

## Reliability and operational limits

- Keep this Node server running continuously. The app's server scheduler is responsible for creating today's/tomorrow's slots, cutoff, start, timed scoring and settlement; there is no separate ChatGPT reminder/automation.
- Persistent SQLite data stores bookings, games, scores, processed declarations, reserve ledger and prize ledger. Restart does not duplicate paid entries or prizes.
- If the server misses an unopened event's start by more than two minutes, that event is cancelled and human fees refunded. Started games resume from stored state; elapsed turn/round deadlines still apply.
- This remains a **single-process server**. A 1,000-seat event's creation and table partitioning were tested; concurrent live play by 1,000 real browser clients was **not load tested**. Do that capacity validation before a live large event.
- Bank transfers, payment gateways, WhatsApp/SMS and identity verification are still not connected. This build records app wallet entries and admin decisions only.

## Included verification

`npm run check` and `npm test`: **18 tests, all passed**. Coverage includes IST scheduling, 18 events/day, tomorrow visibility, reserve gating, duplicate bookings, cancellation/rebooking, exact cutoff, 999 labelled Computer seats for one human in a 1,000-seat event, 167 correctly sized tables, three-round ranking, one-time prize credit, ties, restarts, refunds, frozen published prize tables, role checks and the existing rummy/wallet suite.
