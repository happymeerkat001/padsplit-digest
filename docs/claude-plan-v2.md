Here's claude's plan, how do I get it saved into a file so that codex to execute and checkoutput: PadSplit Daily Digest — Sender Categorization + Honeywell Thermostats                                                                                                                           
                                                                                                                                                                                                 
 Context                                                                                                                                                                                         

 The existing system classifies PadSplit emails by intent and fetches from Gmail labels. Two changes are needed:

 1. Email digest: Switch to sender-based categorization (5 buckets) and sender-based Gmail search. Keep intent classification in DB but display digest grouped by sender.
 2. Honeywell thermostats: Scrape thermostat readings from Total Connect Comfort portal and append to the daily digest.

 Schedule changes from 3x daily to once at 12pm CT.

 ---
 Part A: Sender-Based Email Digest

 A1. src/config.ts

 - Change schedule.digestTimes → ['0 12 * * *'] (noon only)
 - Remove gmail.labels config
 - Add SENDER_CATEGORIES mapping (see below)
 - Add honeywell config section (username, password, sessionPath)
 - Make openai.apiKey validation a warning, not required

 A2. src/gmail/fetch.ts

 - Replace label-based fetch with Gmail q search:
 from:(support@padsplit.com OR maintenance@padsplit.com OR maint@padsplit.com OR no-reply@padsplit.com OR info@padsplit.com OR messenger@padsplit.com) after:<last_processed_timestamp>
 - Use gmail.users.messages.list with q parameter
 - Keep getMessage parser (already extracts from, subject, body)
 - Derive source from from header by matching against sender categories

 A3. src/db/schema.sql + src/db/items.ts + src/db/init.ts

 - Add sender_email TEXT column to digest_items
 - Add migration in init.ts (ALTER TABLE ADD COLUMN IF NOT EXISTS)
 - Update insertItem to accept/store sender_email
 - Update DigestItem interface: add sender_email, widen source to string

 A4. src/digest/builder.ts

 - Replace groupByUrgency with groupBySenderCategory:

 | Category                              | Senders                                      |
 |---------------------------------------|----------------------------------------------|
 | Support / Move-In / Move-Out / Rating | support@padsplit.com                         |
 | Maintenance                           | maintenance@padsplit.com, maint@padsplit.com |
 | No Reply / Info                       | no-reply@padsplit.com, info@padsplit.com     |
 | Member Messages                       | messenger@padsplit.com                       |
 | Others                                | any unmatched sender                         |

 - formatItem: show subject line as primary info
 - Add thermostat section at bottom (see Part B)

 A5. src/index.ts

 - Pass email.from as sender_email when inserting items
 - Add Honeywell scrape step before digest build (see Part B)

 ---
 Part B: Honeywell Thermostat Scraping

 B1. src/config.ts — Add Honeywell config

 honeywell: {
   username: optional('HONEYWELL_USERNAME', ''),
   password: optional('HONEYWELL_PASSWORD', ''),
   sessionPath: './data/honeywell-session.json',
 }

 B2. src/scraper/honeywell.ts — New file

 - Login flow: Navigate to https://mytotalconnectcomfort.com/portal, fill username/password, submit
 - Session persistence: Save storageState to ./data/honeywell-session.json after login; restore on subsequent runs
 - Session check: Try loading portal with saved state; if redirected to login → re-login
 - Scrape thermostats: After login, scrape the portal page for each thermostat:
   - name — thermostat/location name
   - currentTemp — current temperature reading
   - setpoint — target temperature
   - mode — heat / cool / off
   - lastUpdated — timestamp if visible
 - Return array of ThermostatReading objects
 - Use existing logger and withRetry utilities

 interface ThermostatReading {
   name: string;
   currentTemp: number;
   setpoint: number;
   mode: 'heat' | 'cool' | 'off' | string;
   lastUpdated: string | null;
 }

 B3. src/digest/builder.ts — Add thermostat section

 - Accept optional ThermostatReading[] parameter in buildAndSendDigest
 - Append "Thermostat Status" section at bottom of digest:
 --- THERMOSTAT STATUS ---

 • Living Room: 72°F (set: 70°F, mode: heat) — Updated 2 min ago
 • Bedroom: 68°F (set: 68°F, mode: cool) — Updated 5 min ago

 B4. scripts/setup-honeywell.ts — New setup script

 - Opens browser (headless: false) to mytotalconnectcomfort.com/portal
 - Fills credentials from env vars, submits login
 - Saves storageState to ./data/honeywell-session.json
 - Verifies portal loads after login
 - Add npm script: "setup:honeywell": "tsx scripts/setup-honeywell.ts"

 B5. src/index.ts — Add Honeywell step to pipeline

 - Between classify and digest steps, add: scrape thermostats
 - Pass readings to buildAndSendDigest
 - Graceful skip if Honeywell not configured (no creds → warn and skip)

 ---
 .env.example additions

 HONEYWELL_USERNAME=           # Honeywell Total Connect Comfort login
 HONEYWELL_PASSWORD=           # Honeywell Total Connect Comfort password


 ---
 Files Summary

 ┌────────────────────────────┬─────────────────────────────────────────────────────┐
 │            File            │                       Action                        │
 ├────────────────────────────┼─────────────────────────────────────────────────────┤
 │ src/config.ts              │ Edit: schedule, sender categories, honeywell config │
 ├────────────────────────────┼─────────────────────────────────────────────────────┤
 │ src/gmail/fetch.ts         │ Edit: sender-based search replaces label fetch      │
 ├────────────────────────────┼─────────────────────────────────────────────────────┤
 │ src/db/schema.sql          │ Edit: add sender_email column                       │
 ├────────────────────────────┼─────────────────────────────────────────────────────┤
 │ src/db/items.ts            │ Edit: interface + insertItem for sender_email       │
 ├────────────────────────────┼─────────────────────────────────────────────────────┤
 │ src/db/init.ts             │ Edit: add column migration                          │
 ├────────────────────────────┼─────────────────────────────────────────────────────┤
 │ src/digest/builder.ts      │ Edit: sender grouping + thermostat section          │
 ├────────────────────────────┼─────────────────────────────────────────────────────┤
 │ src/index.ts               │ Edit: pass sender_email, add thermostat step        │
 ├────────────────────────────┼─────────────────────────────────────────────────────┤
 │ src/scraper/honeywell.ts   │ New: Honeywell login + thermostat scraping          │
 ├────────────────────────────┼─────────────────────────────────────────────────────┤
 │ scripts/setup-honeywell.ts │ New: interactive Honeywell session setup            │
 ├────────────────────────────┼─────────────────────────────────────────────────────┤
 │ .env.example               │ Edit: add Honeywell env vars                        │
 ├────────────────────────────┼─────────────────────────────────────────────────────┤
 │ package.json               │ Edit: add setup:honeywell script                    │
 └────────────────────────────┴─────────────────────────────────────────────────────┘

 ---
 Verification

 1. Email fetch: npm start -- --run → emails fetched by sender, sender_email stored in DB
 2. Digest grouping: Digest email shows 5 sender categories with subject lines
 3. Honeywell setup: npm run setup:honeywell → logs in, saves session
 4. Honeywell scrape: Thermostat readings appear at bottom of digest
 5. Schedule: npm run dev → single cron at noon CT
 6. Graceful fallback: Without Honeywell creds, digest sends with just emails (no crash)
 7. Idempotency: Running twice doesn't duplicate emails (itemExists check)
 8. Unknown senders: Emails from unrecognized addresses land in "Others"
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌