# Dupond Visual Identity & Character System

This specification documents the visual identity, character avatars, color palette, and display guidelines for **Dupond Orchestrator**. These assets unify the README, technical documentation, and future application UI under a coherent, friendly narrative design.

---

## 🎨 1. Concept & Visual Narrative

Dupond is framed around a classic detective concept: **Dupond**, a bowler-hatted detective coordinator, directing a specialized crew of friendly, cream-bodied robot specialists.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Dupond (Coordinator)                           │
│                     Bowler hat, moustache, black trench coat                │
└───────┬──────────────────┬─────────────────┬─────────────────┬──────────────┘
        │                  │                 │                 │
        ▼                  ▼                 ▼                 ▼
   ┌─────────┐       ┌───────────┐     ┌───────────┐     ┌───────────┐
   │ Planner │       │  Coding   │     │ Verifier  │     │ Reviewer  │
   │  Robot  │       │  Worker   │     │   Robot   │     │   Robot   │
   │ Holding │       │  Behind   │     │  Holding  │     │  Reading  │
   │   map   │       │  laptop   │     │ magnifier │     │  document │
   └─────────┘       └───────────┘     └───────────┘     └───────────┘
                                                               │
                                                               ▼
                                                       ┌──────────────┐
                                                       │   Delivery   │
                                                       │    Agent     │
                                                       │   Holding    │
                                                       │  briefcase   │
                                                       └──────────────┘
```

> [!NOTE]
> **Approved Project Assets Notice**: These character avatars are approved design assets created specifically for the Dupond project. They draw stylistic homage from early French-Belgian *ligne claire* comic illustration. They do not imply any commercial affiliation, trademark license, or official relationship with Moulinsart, Hergé, or the Tintin franchise.

---

## 🤖 2. Character-to-Role Mapping

Each avatar corresponds to a specific stage in Dupond’s automated pipeline:

| Character | Role Title | Visual Cue | Pipeline Responsibility |
| :--- | :--- | :--- | :--- |
| **Dupond** | **Coordinator** | Bowler hat, moustache, dark coat | Orchestrates sprint state, allocates ephemeral worktrees pinned to `baseCommit`, and manages state machine transitions. |
| **Planner** | **Specification & Tasks** | Robot studying an unfolded parchment map | Breaks user requirements into explicit acceptance criteria, verification commands, and protected path rules. |
| **Coding Worker** | **Implementation Specialist** | Robot typing behind an open laptop | Executes multi-turn tool calling (reading files, executing patch edits, running permitted commands) in an isolated Git worktree. |
| **Verifier** | **Authoritative Verification** | Robot inspecting clues through a magnifying glass | Executes operator test commands inside an OS sandbox (Seatbelt / Linux container); enforces worktree cleanliness and protected path invariance. |
| **Reviewer** | **Audit & Diff Inspector** | Robot carefully reading an unfolded dossier | Collates execution telemetry, unified git diffs, and verification check outputs for mandatory human operator inspection. |
| **Delivery Agent** | **PR Delivery Specialist** | Robot carrying a slate-blue briefcase | Reconciles remote base branch drift, authoritatively re-verifies merge candidates, and delivers reviewable PRs via the `gh` CLI. |

---

## ⚖️ 3. Workflow Responsibilities vs. Implemented Capabilities

To maintain technical accuracy across documentation and UI, maintainers and contributors must observe these core distinctions:

1. **Workflow Responsibilities, Not Six Disjoint LLM Agents**:
   - The avatars represent distinct **stages and responsibilities** in Dupond’s server-authoritative pipeline.
   - They do **not** imply that six independent autonomous LLM models run simultaneously. The system architecture coordinates tasks through a central Node.js/TypeScript server engine (`server.ts`, `LifecycleService`, `RepairCoordinator`).
2. **The Verifier is Authoritative OS Sandboxing, Not an LLM**:
   - The **Verifier** avatar symbolizes external, deterministic execution inside an OS-level sandbox (Apple Seatbelt or rootless Podman/Docker).
   - Verification decisions are derived from command exit codes (`exitCode === 0`) and clean `git status` checks—**never** from worker self-attestation or LLM opinions.
3. **The Reviewer Does Not Replace Human Approval**:
   - The **Reviewer** avatar symbolizes telemetry and evidence preparation for human review.
   - It **never** replaces the required operator approval gate. Every delivery transition requires explicit human approval (`isApproved: true`, `approvedBy: "operator"`) bound to the exact commit SHA.
4. **Provider Independence is Separate from Character Identity**:
   - The **Coding Worker** character is completely decoupled from any single AI vendor.
   - The worker executes using whichever provider/model is selected by operator configuration (`GEMINI_MODEL="gemini-3.5-flash"` or `OPENAI_MODEL="gpt-4o-mini"`). Provider branding must never replace or alter the character avatar.

---

## 🎨 4. Palette & Visual Consistency

The character illustrations follow a *ligne claire* (clear line) aesthetic characterized by strong dark outlines, flat warm tones, and absence of heavy cross-hatching. The palette harmonizes with the header banner ([`resources/dupond-banner.png`](../resources/dupond-banner.png)):

| Color Swatch | Hex Code | Visual Element | Purpose & Usage |
| :--- | :--- | :--- | :--- |
| **Porcelain Cream** | `#F5ECE0` / `#F4EBD9` | Robot chassis body | Primary surface for all friendly robot characters. |
| **Ink Line Black** | `#1A1A1A` / `#000000` | Contours, eyes, moustache, bowler hat | Consistent outline weight defining silhouettes. |
| **Slate Navy** | `#34495E` / `#4A6572` | Briefcase, laptop body, coat, accents | Anchoring dark cool tone for accessories. |
| **Cerulean Sky** | `#5DADE2` / `#70BCE6` | Lenses, screen glow, hero banner backdrop | Vibrant accent color representing active computation. |
| **Parchment Amber** | `#F5DEB3` / `#E8C88B` | Map, dossier pages, document sheets | Warm paper tones for specifications and reports. |
| **Detective Peach** | `#F5B070` | Dupond’s skin tones | Classic human detective warmth contrasting robot porcelain. |

### Transparency & Format
- All individual avatar files are high-resolution `1254 x 1254` square PNGs with an **alpha transparency channel**.
- Silhouettes are bounded cleanly so characters render seamlessly against both light (`#FFFFFF`, `#F8FAFC`) and dark (`#0F172A`, `#18181B`) backgrounds without haloing or matte artifacts.

---

## 📁 5. Asset Directory & Filenames

The canonical image files reside in [`resources/agents/`](../resources/agents/):

```
resources/
├── dupond-banner.png         # Main repository banner (900x375)
├── dupond-logo.png           # Square avatar mark (1254x1254)
└── agents/
    ├── coordinator.png       # Dupond (bowler hat & moustache)
    ├── planner.png           # Planner robot with parchment map
    ├── coding-worker.png     # Coding worker robot with laptop
    ├── verifier.png          # Verifier robot with magnifying glass
    ├── reviewer.png          # Reviewer robot reading dossier
    ├── delivery.png          # Delivery agent robot with briefcase
    └── lineup.png            # Full six-character adventure lineup (1536x1024)
```

---

## 📐 6. Display, Framing & Accessibility Guidelines

### Framing & Proportions
- **Head-and-Shoulders Framing**: When cropping or embedding avatars in compact UI components, preserve each character's key accessory (Dupond's bowler hat and moustache, the planner's map, the worker's laptop, the verifier's magnifying glass, the reviewer's document, the delivery agent's briefcase).
- **Aspect Ratio**: Keep avatars strictly square (`1:1`). Do not stretch or distort dimensions.

### Recommended Sizing
| Context | Recommended Dimensions | Notes |
| :--- | :--- | :--- |
| **README & Major Docs** | `88px` – `96px` square | Crisp on mobile and desktop Markdown tables. |
| **UI Task Cards / Columns** | `48px` – `64px` square | Header avatar for kanban columns or task specialists. |
| **Compact Status Chips / Rows** | `24px` – `32px` square | Inline badge beside agent logs and activity entries. |
| **Hero Lineup Banner** | `100%` width (max `900px`) | Use [`resources/agents/lineup.png`](../resources/agents/lineup.png) for full-width team intros. |

### Accessibility (a11y)
- **Always provide descriptive alt text**: Include both character name and functional role (e.g., `alt="Verifier robot holding a magnifying glass — Authoritative Verification Specialist"`).
- **Always accompany with text labels**: Never use an avatar alone to indicate state, role, or action. Always render the textual role name alongside or beneath the image.

---

## 🚦 7. Future UI Integration Guidelines

When integrating character avatars into the Dupond web interface ([`src/App.tsx`](../src/App.tsx) and component library):

### Separate Status Badges
Do **not** recolor or modify the avatar PNG files to indicate execution state. Status indicators must be rendered as independent badge overlays or border rings:

- **Running / In Progress**: Pulsing emerald green ring or dot (`#10B981`, `bg-emerald-500 animate-pulse`).
- **Waiting / Idle**: Neutral slate indicator (`#64748B`, `bg-slate-500`).
- **Blocked / Approval Required**: Vibrant amber badge (`#F59E0B`, `bg-amber-500`).
- **Failed / Error**: Rose red indicator (`#EF4444`, `bg-rose-500`).

### Independent Provider Attribution
When displaying the **Coding Worker** on active runs:
- Display the configured LLM provider and model name as a distinct, standalone tag (e.g. `[Gemini 3.5 Flash]` or `[OpenAI gpt-4o]`).
- Do not morph or brand the character avatar with third-party logos. The robot represents the execution role; the tag identifies the underlying intelligence provider.

---

## 🚫 8. Usage Restrictions

1. **Approved Artwork Only**: Do not substitute generic emoji (`🤖`, `🕵️‍♂️`), SVG geometric place-holders, or newly generated AI images that diverge from the approved *ligne claire* cream/porcelain palette.
2. **Restraint in Documentation**: Use avatars selectively in guides where they clarify architectural boundaries and pipeline roles. Avoid decorative clutter on every section heading.
3. **No Unofficial Claims**: Do not add text claiming official licensing or copyright connection to Hergé / Tintin. The design is an inspired homage belonging to the Dupond open source project.
