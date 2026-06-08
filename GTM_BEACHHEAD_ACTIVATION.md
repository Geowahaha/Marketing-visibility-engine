# AIMark — Beachhead Activation Kit (Sell Monitoring)
### The non-code work that gets the first 5 paying customers
_Phase 1 of the owner's roadmap: ขาย Monitoring. The product is built and live; this is the sales motion to fill it._

> The data moat is complete in code. It now needs **customers** to start compounding.
> This kit is everything needed to close the first ones — ready to send, demo, and onboard.

---

## 0. The honest situation

- **Built + live:** scan → audit history → recommendations → alerts → monitoring,
  gated behind **Growth Monitor ฿490/mo**; benchmark/impact/competitor Intelligence;
  7 data streams capturing.
- **Missing:** customers. Zero today. Everything below is to fix exactly that.
- **Two warm beachheads with real, painful, specific data already in hand**
  (successcasting, pinpoint) — start there, not cold.

---

## 1. Owner activation checklist (only you can do these — ~30 min total)

1. **Turn on the engine** — set the monitoring cron secret so autonomous monitoring runs:
   ```
   cd web
   npx wrangler pages secret put AIMARK_CRON_KEY --project-name aimark   # any long random string
   ```
   Then add a Cloudflare **Cron Trigger** (or an external cron) that POSTs
   `https://aimark.pages.dev/api/monitoring/run` with header `x-cron-key: <that key>`.
   Until this is on, monitoring alerts only fire on manual re-scan.
2. **Prove the money path** — once, end-to-end:
   - Sign in at `https://aimark.pages.dev/dashboard` → connect a site → click **Upgrade**
     → complete a real ฿490 card subscription (or PromptPay 30-day pass) → confirm the
     plan badge flips to "Growth Monitor" and the monitor toggle unlocks.
   - This proves Stripe live + the gate + entitlement before you ask a customer to pay.
3. **Pick the launch day** and block 2 hours to send the two outreach messages below.

---

## 2. The offer (what they actually buy)

**Growth Monitor — ฿490/เดือน**
- เฝ้าดูการมองเห็นบน AI + Google ต่อเนื่อง (สแกนซ้ำอัตโนมัติทุกสัปดาห์)
- แจ้งเตือนทันทีเมื่อคะแนนตก หรือคู่แข่งแซง หรือ AI เลิกอ้างถึงคุณ
- รายการ "ต้องแก้ก่อน" จัดอันดับตาม ROI + เปรียบเทียบคู่แข่ง
- ได้ถึง 5 เว็บไซต์

**Positioning (one line):** *"เราไม่ได้ขายรายงาน — เราเฝ้าดูให้ AI มองเห็นธุรกิจคุณ และเตือนคุณก่อนที่ลูกค้าจะหายไปหาคู่แข่ง."*
(We don't sell a report — we watch your AI visibility and warn you before customers go to a competitor.)

**Why monthly (not one-time):** AI answers change weekly; a one-time fix decays.
Monitoring is the thing that stays valuable → that's why it recurs.

---

## 3. Beachhead #1 — successcasting.com (โรงหล่อ / foundry)

**Real ammo (from our probes):** score 66→**D**, **AI Search 40** (thin content — AI
can't understand what you cast/for whom), Facebook serves AI bots **0/8** (AI literally
can't read your social). We already generated real fix artifacts (services/FAQ pages +
FAQPage schema) — proof we do the work, not just report it.

**Outreach (TH, send as-is):**
> สวัสดีครับ ผมลองเช็กการมองเห็นของ successcasting บน AI (ChatGPT/Gemini/Perplexity) ให้
> ปรากฏว่าเวลาคนถาม AI หา "โรงหล่อ/งานหล่อโลหะ" เว็บคุณ **แทบไม่ถูกพูดถึงเลย** —
> คะแนน AI Search อยู่ที่ 40/100 และ Facebook ของคุณ AI อ่านไม่ได้เลย (0/8 บอท)
> แปลว่าโฆษณาที่จ่ายไปกำลังพาคนมา แต่ตอน AI แนะนำผู้ผลิต เขาไม่เห็นคุณ
> ผมแก้ให้ดูฟรี 1 หน้า + รายงานสดให้เห็นก่อน-หลัง ถ้าโอเคค่อยให้เราเฝ้าดูต่อเดือนละ 490
> ขอเวลา 15 นาทีโชว์สดได้ไหมครับ?

**Close:** the 15-min demo (§5) → "ให้เราเฝ้าดูต่อ ฿490/เดือน เตือนทุกครั้งที่คะแนนตกหรือคู่แข่งแซง."

---

## 4. Beachhead #2 — pinpointaccountingservice.com (สำนักงานบัญชี / accounting)

**Real ammo (from our live citation probe — this is the killer pitch):** for 8 high-value
English accounting queries, pinpoint was cited **0/24 times**. Worse, AI actively
recommends a **Vietnam consultancy, a Bangladesh firm, and Indian outsourcing shops** for
"register a company in Thailand / bookkeeping Thailand" — and **Acclime wins ~5/8**.
pinpoint already has Thai district pages (asoke/ladprao/rama9) but a **confirmed English
gap** (Thai-only titles suppress English AI answers).

**Outreach (TH/EN, send as-is):**
> เรียนทีม Pinpoint ครับ — ผมทดสอบจริงว่าเวลาชาวต่างชาติถาม AI ว่า *"accounting firm /
> register a company in Thailand"* AI แนะนำใครบ้าง ผลคือ AI แนะนำ **บริษัทจากเวียดนาม
> บังกลาเทศ และอินเดีย** ให้จดบริษัทไทย — และอ้าง **Acclime** เกือบทุกครั้ง ส่วน Pinpoint
> ถูกอ้างถึง **0 จาก 24 ครั้ง** ทั้งที่คุณเป็นเจ้าถิ่นตัวจริง
> ช่องว่างคือ "หน้าภาษาอังกฤษ × รายเขต/บริการ" ที่ AI หยิบไปตอบได้ ผมทำหน้าตัวอย่างให้ดูฟรี 1
> หน้า แล้ววัดซ้ำใน 2-4 สัปดาห์ให้เห็น before/after ถ้าได้ผลค่อยให้เราเฝ้าดู+เตือนต่อเดือนละ 490
> ขอ 15 นาทีโชว์ผลสดไหมครับ?

**Why this closes:** accounting is recurring/scale (not one foundry); the 0/24 + "AI sends
your clients to a Bangladesh firm" is visceral and *true*; the fix (English × district/service
pages + schema) is exactly what we already build.

---

## 5. The 15-minute live demo script (reusable for any lead)

1. **(2m) Paste their URL** into the free scan → show the score + the red items.
2. **(3m) The gut-punch** → run the citation probe live: *"watch what AI says when I ask for
   your kind of business."* Show competitors named, them absent. (This is the moment they buy.)
3. **(3m) Show it's fixable** → the "do these 3 first" list + generate ONE real fix page live.
4. **(2m) Show the moat** → benchmark: *"you're in the bottom X% of your industry."*
5. **(3m) The recurring value** → *"AI changes weekly. We re-check automatically and LINE/email
   you the moment you slip or a competitor passes you — that's the ฿490/เดือน."*
6. **(2m) Close** → connect their site + enable monitoring on the spot (needs the plan).

**One-line pitch if you only get 30 seconds:** *"AI กำลังแนะนำคู่แข่งคุณ ไม่ใช่คุณ — เราเฝ้าดูและเตือนคุณก่อนเสียลูกค้า เดือนละ 490."*

---

## 6. Onboarding (what happens the moment they say yes)

1. They sign in at `/dashboard` (Google) → **Connect site**.
2. First audit runs → score + "do these 3 first" appears.
3. **Upgrade → ฿490** (card = auto-renew; PromptPay = 30-day pass).
4. **Enable monitoring** (now unlocked) → first auto re-audit scheduled.
5. Apply the first fix → mark it applied → next audit shows the +N (the `impact` proof).
6. Within a week they get their first **alert** — that's the "aha, this is alive" moment that
   drives the second payment cycle.

---

## 7. 30-day plan to the first 5 customers

| Day | Action |
|---|---|
| 1 | Owner checklist §1 (cron + live subscribe test). |
| 2 | Send both beachhead messages. Book 2 demos. |
| 3–5 | Run the 2 demos → aim to close 1–2 at ฿490. |
| 6–10 | Each closed customer: deliver 1 real fix → re-probe → before/after proof. |
| 10 | Ask each happy customer for **1 referral** in their industry (foundry/accounting peers). |
| 11–25 | 3 referral demos + post the before/after proof publicly (1 case study). |
| 26–30 | Close to 5 paying. Confirm the first renewals land (the 80%-second-cycle KPI). |

**Target:** 5 paying × ฿490 = **฿2,450 MRR** in month 1 — and, more importantly, 5 customers
× 7 data streams beginning to compound the moat.

---

## 8. Objection handling

- *"แพงไป / ขอแบบครั้งเดียว"* → ฿490 ราค่ากาแฟไม่กี่แก้ว; ครั้งเดียวมันเสื่อมเพราะ AI เปลี่ยนทุกสัปดาห์ —
  คุณจ่ายเพื่อ "ไม่ตกขบวน" ไม่ใช่จ่ายเพื่อรายงาน.
- *"ไม่เชื่อว่าได้ผล"* → เราวัด before/after จริงและโชว์ในแดชบอร์ด; ไม่ดีขึ้นก็เห็นเอง (เราไม่กล้าโม้
  อันดับถาวร — เราวัดของจริง).
- *"ทำเองได้ไหม"* → ได้ แต่ต้องเช็กทุกสัปดาห์ทุกเอนจินเอง; เราทำให้อัตโนมัติ + เตือนให้.
- *"คู่แข่งเจ้าอื่น"* → คนอื่นส่ง PDF รายงาน; เราเฝ้าดูต่อเนื่อง + ลงมือแก้ + พิสูจน์ผล.

---

**Bottom line:** the engine is built. This kit turns it into the first ฿2,450 MRR and the
first real data in the moat. The fastest path is the two warm leads above — their pain is
real, specific, and already measured. Send the messages.
