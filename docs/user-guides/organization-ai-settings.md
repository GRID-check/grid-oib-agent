# Organization AI Settings: Models, Usage & Budgets

Org admins manage both features from **Organization** (top-right menu →
Organization). Members can see their own usage; everything else is
admin-only.

## AI model configuration

Choose which OpenRouter model each *agent group* runs on:

| Group | What it does |
|---|---|
| Intent & routing | classifies each message and answers meta questions |
| Clarifier | asks follow-up questions and drafts research plans |
| Shallow research | the default research agent |
| Deep research | orchestrator/planner/researcher/writer for deep runs |
| Deep-research source router | routes deep-research subtasks to sources |
| Memory reflection | background pass that distills project memory |

- **Change** opens a search over the OpenRouter catalog. Only models that fit
  the group are listed (e.g. research groups require tool calling and a large
  context window) — an unsuitable model cannot be saved.
- Saving creates a **new version** (with your optional change note). New
  conversations pick the change up immediately; running conversations keep
  their current models until reconnected.
- **Version history** shows every past configuration with author and date —
  activate any older version to roll back, or *Deactivate overrides* to
  return to the built-in defaults.

## Usage & budgets

The card shows LLM spend **today** and **this month** as a bar per window:
each colored segment is one model (hover a segment or a legend entry for
exact figures and request counts); the legend below lists spend per model.

- **Limits**: every organization starts with **€10/day and €100/month**.
  Admins can change either or clear it (no limit). When a budget is
  exhausted, new chat requests are blocked until the window rolls over or an
  admin raises the limit — members see a clear message.
- **Member & project limits**: optional stricter caps per member (WorkOS
  user id) or per project (project id). They can never exceed the
  organization limits and are enforced *in addition to* them. Project
  admins may set their own project's limit.
- Costs are recorded exactly as OpenRouter reports them (USD) and compared
  against your EUR limits with a fixed deployment-configured rate. Every
  request is kept in an audit ledger (who, which project, which model, what
  cost), and every limit change records who made it.
