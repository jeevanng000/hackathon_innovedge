# AutoPatch — Find the Root Cause. Patch with Proof.

> **An autonomous, dual-engine bug detection & repair workbench** that pairs deterministic AST/sandbox verification with hedged Gemini AI reasoning — giving developers **sub-second initial diagnostics**, **surgical Before/After diffs**, and **cryptographically audited patch decisions** across multi-file projects.

---

## 🧱 First, Explain It Like I'm 10 (ELI10)

Imagine you built a giant **LEGO castle** (your code), and right before show-and-tell, two scary things happen:
1. Every time someone walks across the drawbridge with **zero coins**, the whole bridge collapses (`ZeroDivisionError`).
2. Worse, you accidentally left a secret tunnel wide open so anyone can walk straight into the treasure room (`SQL Injection`).

If you ask a normal AI helper to "fix my castle," it often **guesses**, tears down half the wall, and glues random bricks together — sometimes breaking three other towers!

**AutoPatch works like a 2-person LEGO Pit Crew instead:**

| Pit Crew Member | What They Do in Plain English | Real Tech Behind It |
| :--- | :--- | :--- |
| **🔍 Kid #1: The Safety Inspector** *(Super Fast!)* | Drops a test toy into a **locked glass box** so nothing in your bedroom can break. Finds the *exact* brick numbers that wobbled in less than a second! | Python / Acorn AST + GCC/esbuild + Linux Sandbox (`engine/sandbox_runner.ts`) |
| **🛠️ Kid #2: The Master Builder** *(Smart & Surgical!)* | Reads Kid #1's exact brick notes, swaps out **only the broken bricks** (`Before -> After`), and tests **normal, tricky, and broken toys** to prove the bridge holds. | Gemini AI w/ `ThinkingLevel.MINIMAL` + 3.5s Hedged Fast-Race (`engine/gemini_bug_scanner.ts`) |
| **📓 You + The Stamp Book** *(Trust & Proof!)* | **You** stay the boss! Click **Accept Patch** or **Reject** in a glass diff window, and AutoPatch stamps your choice into a tamper-proof diary. | Interactive Glass Diff + SHA-256 Chained Audit Ledger (`engine/audit_store.ts`) |

**And if you bring a whole bucket of castles (`Upload Files`)?**  
AutoPatch automatically matches each castle with its own instruction test sheet (`auth.py` ↔ `test_auth.py`), puts **4 pit-crew teams to work at the same time**, and hands you one combined scoreboard!

---

## ⚡ How AutoPatch Solves Tough Code Fast (Architecture)

```text
  User Drops 1 File or 20 Files (Source + Tests + Optional Voice Note / Traceback)
                                       │
                        Auto-Pairs Source ↔ Test Suites
                     (4 Concurrent Workers in src/App.tsx)
                                       │
           ┌───────────────────────────┴───────────────────────────┐
           ▼ (Immediate ~150ms–1s)                                 ▼ (Parallel AI + Precheck)
   POST /api/analyze                                       POST /api/autopatch
   ┌───────────────────────────┐                           ┌──────────────────────────────┐
   │ • AST & Taint Analysis    │                           │ • Parallel Deterministic       │
   │ • Compiler Diagnostics    │                           │   Precheck (650ms head-start)  │
   │ • Isolated Sandbox Run    │                           │ • Optional Neo4j GraphRAG      │
   │ • Ochiai / Tarantula SBFL │                           │ • Hedged Gemini Race (3.5s)    │
   └─────────────┬─────────────┘                           │ • SHA-256 LRU Response Cache │
                 │                                         └──────────────┬───────────────┘
                 │  Progressive Output (No Blank Waiting!)                │
                 └───────────────────────►┌───────────────────────────────┘
                                          ▼
                            mergeAutoPatchReports()
               • Deduplicates overlapping statements & titles
               • Combines Gemini semantic fixes + Sandbox/AST bugs
               • Preserves line-anchored Before/After minimal diffs
                                          │
                                          ▼
                   Human-in-the-Loop Safe Patch Decisions
                Accept / Reject → Tamper-Evident SHA-256 Ledger
```

---

## ✨ What Makes AutoPatch Different for Judges

1. **Zero-Guesswork Grounding (Dual Engine)**:
   Instead of letting an LLM hallucinate line numbers or break syntax, `/api/autopatch` kicks off deterministic AST/sandbox prechecks in parallel and feeds real crash tracebacks + static findings directly into Gemini's structured JSON prompt — then merges any unique deterministic catches back in via `mergeAutoPatchReports`.
2. **Progressive Instant Output + Hedged Fast-Race**:
   - The frontend launches `/api/analyze` (local sandbox) and `/api/autopatch` simultaneously so judges and developers see real bugs and health scores within **~1 second**.
   - On the server, Gemini runs with `ThinkingLevel.MINIMAL`, races a fast fallback model (`gemini-3.1-flash-lite`) if the primary model exceeds 3.5 seconds, and serves repeat scans instantly from an in-memory SHA-256 LRU cache.
3. **True Multi-File & Large-File Execution**:
   - Drag-and-drop or upload multiple source and test files at once (`pairSourceAndTestFiles` pairs `foo.py` ↔ `test_foo.py`, `bar.ts` ↔ `bar.test.ts`, etc.).
   - Executes up to **4 files concurrently** with a unified **Multi-File Execution Switcher**, aggregate health metrics, and one-click **Export All Results** Markdown report.
   - Built with high-capacity 25–50 MB payload limits and line-bounded O(n) diffing (`src/utils/diffAndAudit.ts`) so real-world files run without arbitrary caps.
4. **Honest Verification Tiers & Security Hardening**:
   - **Prompt-Injection Defense**: Untrusted code, error logs, and graph context are strictly fenced inside `<<<UNTRUSTED_DATA_START>>>` delimiters.
   - **Sandbox Isolation**: Untrusted execution runs in isolated temp directories with CPU, memory, output, and process limits (`engine/sandbox_runner.ts`).
   - **Zero-Secret Boot**: Runs out of the box with zero API keys configured via deterministic **Local Sandbox** fallback, and transparently upgrades when `GEMINI_API_KEY` (and optional `NEO4J_*` GraphRAG) are present.

---

## 🌐 Supported Languages & Verification Modes

| Category | Languages | How AutoPatch Verifies |
| :--- | :--- | :--- |
| **Runtime Sandbox Executed** | **Python**, **JavaScript**, **TypeScript**, **C**, **C++**, **Bash / Shell** | Real AST / compiler checks + isolated sandbox execution & unit test verification |
| **Static & Heuristic + AI** | **Java**, **Go**, **Rust**, **C#**, **PHP**, **Ruby**, **SQL**, Generic | Comment/string-aware static heuristics + Gemini semantic repair (never fakes runtime passes) |

---

## 🚀 2-Minute Judge Demo Flow

Want to see everything working end-to-end right away?

1. **Try a Tough Single File**: Paste any multi-bug snippet (or click **Auth Service** / **Pricing Engine**), then click **`Analyze & Patch`**.
   - Watch stage progression + red-highlighted errored lines with inline `Inspect` chips.
   - Open the **Glass Diff Modal** to inspect **Before (Buggy)** vs **After (Focused Fix)**, root cause, and generated **Normal / Boundary / Invalid** test cases.
   - Click **`Accept Patch`** (or use `N` / `P` / `Enter` keyboard navigation) and see the live **Health Score** and **Safe Change History** counter update.
2. **Try Multi-File Concurrent Execution**: Click **`+ New Scan`** → **`Upload Files`**, select multiple files (e.g., `service.py`, `test_service.py`, `cart.ts`), and click **`Analyze & Patch`**.
   - Switch between files in the **Multi-File Execution** bar, inspect individual bug queues, and click **`Export All Results`** for a complete Markdown diagnostic report.
3. **Inspect the Tamper-Evident Ledger & Debugging Dock**: Open the bottom **Debugging Dock** for 5-step execution traces and open **Safe Change History** to export or audit decisions.

---

## 🛠️ Local Setup & Verification Commands

### Prerequisites
- **Node.js 20+** and **Python 3.10+** (with `gcc`/`g++` optional for C/C++ sandbox compilation)
- Optional: `GEMINI_API_KEY` (for Gemini AI semantic detection & voice transcription) and `NEO4J_URI` / `NEO4J_USERNAME` / `NEO4J_PASSWORD` (for optional GraphRAG repository context). See `.env.example`.

### Run Locally
```bash
npm install
npm run dev
```
Open `http://localhost:3000`. (Works immediately in Local Sandbox mode even without `GEMINI_API_KEY`; add `GEMINI_API_KEY` to `.env` for full dual-engine AI + sandbox mode.)

### Run Tests, Type Checks & Production Build
```bash
# Run all 50+ unit, security, diffing, multi-language, and HTTP contract tests
npm test

# TypeScript + Python engine syntax verification
npm run check

# Production bundle
npm run build
npm start
```

---

## 📁 Key Project Structure

```text
├── server.ts                        # Hardened Express + Vite server (/api/autopatch, /api/analyze, /api/validate, /api/audit)
├── engine/
│   ├── autopatch_engine.py          # Python AST analysis, SBFL, & safe patch generator
│   ├── multi_lang_engine.ts         # Multi-language static/compiler/sandbox verification engine
│   ├── gemini_bug_scanner.ts        # Hedged Gemini AI scanner, LRU cache, & voice note transcription
│   ├── sandbox_runner.ts            # Isolated subprocess execution with resource & timeout guards
│   ├── audit_store.ts               # Append-only SHA-256 hash-chained audit ledger
│   └── graphrag/                    # Optional Neo4j AuraDB ingestion & root-cause retrieval
└── src/
    ├── App.tsx                      # Concurrent 4-worker batch scheduler & progressive UI state
    ├── utils/autopatchWorkflow.ts   # Report normalization, test pairing, patch application & merging
    └── components/
        ├── WelcomeHeroInput.tsx     # Multi-file upload, drag-and-drop, voice notes & preset demos
        ├── WorkspaceDashboard.tsx   # Batch switcher, Health Score, code spotlight & bug queue
        ├── BugGlassModal.tsx        # Glass Before/After diff inspector & Safe Patch acceptance
        ├── DebuggingDock.tsx        # Collapsible trace logs & sandbox test pass/fail breakdown
        └── SafeChangeHistoryView.tsx# Filterable audit log of accepted & rejected repairs
```
