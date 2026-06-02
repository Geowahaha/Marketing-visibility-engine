# AI Mark — Customer Demo Runbook

A 5–10 minute live demo that takes a prospect from *"why does this matter?"* to
*"how do I pay?"* — built around the real "aha" moments the product can prove on
the spot. Works in English or Thai (key Thai lines included).

> Live site: **https://aimark.pages.dev**
> Public proof-loop demo: **https://aimark.pages.dev/api/proof?share=aimark-pages-dev-82ca195b2c31**

---

## 0. Before the call (30 sec)
- Open **aimark.pages.dev** in your browser. Toggle **ไทย** if the prospect is Thai.
- Have **their website URL** ready, and **their Facebook page/profile URL** ready.
- (Your tester IP already unlocks paid features for free, so the full flow works
  during a demo without paying.)

---

## 1. The hook — scan their real site (90 sec)
1. Paste **their website URL** → **⚡ Analyze visibility**.
2. While it scans, say:
   > *"Search changed. 60% of Google searches now end with no click — people get
   > the answer straight from ChatGPT, Gemini and Google's AI. So the new question
   > isn't 'do you rank?' — it's 'can the AI even read you, and does it recommend
   > you?'"*
   > TH: *"ตอนนี้คนถาม AI แล้วได้คำตอบเลย ไม่กดเข้าเว็บ คำถามใหม่คือ 'AI อ่านเว็บคุณออกไหม และมันแนะนำคุณหรือเปล่า'"*
3. When the score appears, read the **category split** out loud — especially if
   **Technical SEO is high but AI Search/GEO-AEO is low** (very common):
   > *"Your site is technically fine for old Google — but for AI answers, it scores
   > [26]. That's money you're spending on ads going to a page AI can't quote."*

## 2. The gut-punch — prove AI can't see their social (60 sec)
1. Scroll to **Step 2 · Deep analysis → 🤖 AI bot access**. Run it on their site,
   then paste their **Facebook** URL and run it again.
2. Facebook almost always comes back **0/8 — "blocked by robots"**:
   > *"See this? ChatGPT, Claude and Perplexity are literally blocked from reading
   > your Facebook. So when a customer asks AI for a recommendation, you don't
   > exist. Your website is the only thing AI can cite — and that's what we fix."*
   > TH: *"Facebook ของคุณโดนบล็อกไม่ให้ AI อ่าน เวลาลูกค้าถาม AI คุณจะไม่โผล่เลย เว็บคือสิ่งเดียวที่ AI อ้างอิงได้ — และนั่นคือสิ่งที่เราแก้"*

## 3. The proof — are they cited right now? (60 sec)
1. **🔎 AI citations** → it asks Gemini / Tavily / Google a real buyer question.
2. Usually returns **"absent"** for their brand:
   > *"I just asked the AI engines who they'd recommend. Your competitors showed
   > up — you didn't. This is your real starting line."*

## 4. The reveal — one-click fix (90 sec)
1. **Step 1 · ✨ Fix it for me**. It generates the actual files: optimized head +
   schema, AI-friendly robots.txt, llms.txt, an **FAQ/answer block** (the #1
   AI-citation lever), and a **30-day social calendar**.
2. Say:
   > *"This isn't advice — these are the finished files. We can open a pull request
   > on your site, or hand you a copy-paste pack. No technical work on your side."*
   > TH: *"นี่ไม่ใช่คำแนะนำลอย ๆ แต่เป็นไฟล์แก้จริง เราเปิด PR ให้ หรือส่งชุดก็อปวางให้ คุณไม่ต้องแตะโค้ดเอง"*
3. Mention **📈 Prove before/after**: *"After we fix it, we re-scan and show your
   score jump — you see the proof."*

## 5. The close — add credits, pay by PromptPay (90 sec)
1. Open **Credits**. Walk the credit ladder:

   | Plan | Price | One line |
   |---|---|---|
   | **Free scan** | ฿0 | The scan/proof preview they just saw |
   | **500 credits** | ฿199 | Enough for first lead scout, scan, fix package, or handoff work |
   | **1,100 credits** | ฿399 | Better for several prospects or one deeper repair package |
   | **2,400 credits** | ฿799 | Builder pack for batch outreach and proof work |

2. Recommend the credit pack based on immediate work:
   > *"Credits keep this simple: you top up only when you want AI Mark to scan,
   > generate fixes, hand work to the local agent, or prove the after result."*
3. Each pack supports **PromptPay QR** through Stripe Checkout — tap it, they scan
   the QR with their banking app, done:
   > *"Pay by PromptPay — same QR you use every day. No card needed."*
   > TH: *"จ่ายด้วย PromptPay สแกน QR จากแอปธนาคารได้เลย ไม่ต้องใช้บัตร"*

## 6. The public proof demo (60 sec)
If the prospect asks whether before/after proof is real, open:

```text
https://aimark.pages.dev/api/proof?share=aimark-pages-dev-82ca195b2c31
```

Explain:
> *"This is a live public proof-loop smoke test. AI Mark saved the same URL at
> 26/100 before fixes, then after the page was improved and deployed it re-scanned
> at 70/100. The point is not to promise ranking — the point is that AI Mark can
> preserve the baseline, rescan the public page, and show exactly what moved."*

TH:
> *"นี่คือ proof loop จริงบน URL public เดียวกัน ก่อนแก้ได้ 26/100 หลังแก้และ deploy
> แล้วสแกนซ้ำได้ 70/100 เราไม่ได้สัญญาอันดับ แต่พิสูจน์ได้ว่า public signals ขยับจริง"*

---

## Objection handling
- **"Is it safe? Do you need my passwords?"**
  > *"Never. We only read your public pages — the same thing Google sees. No login,
  > no passwords. Payments run on Stripe (bank-grade), and the whole site sits on
  > Cloudflare."* (Point at the 🔒 trust line.)
- **"Will this guarantee I rank #1 on AI?"**
  > *"No honest tool can promise that. What we do is make you *readable and
  > citeable*, then **prove** the before/after. We track it monthly so you see it
  > working."*
- **"฿990 is a lot."**
  > *"It's less than one day of the ad spend that's currently landing on a page AI
  > can't quote. This makes that spend actually convert."*

## What to have ready / gotchas
- If a prospect's site is a **JavaScript-only SPA**, the bot-access check flags
  "JS-render risk" — great talking point: *"AI bots don't run JavaScript, so they
  see almost none of your page."* (Pro's render view shows it visually.)
- The **Human-vs-AI-bot render** is **Pro / on-request** — if asked, say it's
  included in Pro and you'll enable it for their account.
- Keep it to **one prospect URL + one social URL**. Don't over-run analyses.

## One-line pitch (memorize)
> **"AI Mark shows you if ChatGPT, Claude and Google's AI can find and recommend
> your business — then fixes it in one click, and proves your score went up."**
> TH: **"AI Mark บอกว่า ChatGPT, Claude และ AI ของ Google เจอและแนะนำธุรกิจคุณไหม
> แล้วแก้ให้ในคลิกเดียว พร้อมพิสูจน์ว่าคะแนนดีขึ้นจริง"**
