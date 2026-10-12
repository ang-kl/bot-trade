# Code, Skills and Recipes: Evidence and Edge Cases

**Prompt pack | Version 1.0 | 13 October 2026 (SGT)**

**The prompts should challenge both the business assumptions and the implemented behaviour. An edge case is useful when it exposes a specific way the system could reach an incorrect result, violate a constraint or report success without sufficient evidence. Listing many edge cases does not establish reliability in real environments.**

Here, I interpret **“false intelligence” as an appearance of capability that is unsupported by the code’s behaviour or the available evidence**. This includes convincing explanations, polished interfaces, plausible outputs and passing tests that do not establish the claimed result. It is a practical description, not a diagnosis of a model’s understanding or an engineer’s intentions.

The following prompts preserve the safeguards from the earlier skill and recipe assessments: independently grounded requirements, appropriate skill selection, explicit assumptions, enforced constraints, checks between steps, and evidence with stated limits. **No particular codebase, skill package or operational recipe has been supplied for assessment here. These are reusable review instructions.**

## 1. Shared instructions: apply these to all three reviews

Use this common block once, followed by the relevant prompt below. For a complete assessment, start with **skill and requirement fit**, examine **code behaviour**, then assess the **whole recipe**. This order helps expose a correct implementation of an inappropriate business rule.

```text
TASK: Assess claimed capability using requirements, counterexamples
and observable evidence.

CONTEXT
- Business model, sector and department: [state]
- Intended outcome and users: [state]
- Supported operating conditions: [state]
- Repository/files and revision: [identify]
- Candidate skills and versions: [identify]
- Recipe and version: [identify]
- Authoritative policies, specifications and examples: [provide]
- Required constraints and their owners: [provide]
- Actual execution environment, if known: [state]
- Existing authorisation for inspection, testing and changes: [state]

If an input is unavailable, mark it Unknown. Do not invent it.

MODE AND AUTHORITY
Use only the scope already authorised.
If no execution scope is recorded, perform read-only review and
draft checks. Do not modify code or run the proposed tests.

Follow applicable project instructions and the approved toolchain.
Before implementation or test execution, obtain the required
go-ahead unless it already covers that exact scope.

Before any new consequential action, state its action, target,
reversibility and supporting evidence, and await APPROVE <action>.
A review or testing approval does not authorise production effects.

WORK THROUGH THESE SIX STAGES
1. Intent: Define the claimed outcome and acceptance criteria.
2. Interpretation: Map the actual workflow and important decisions.
3. Assumptions: Identify the source and limits of each material rule.
4. Invariants: State what must remain true within the defined scope.
5. Execution: Identify what was inspected, proposed or actually run.
6. Evidence: Report findings, counterexamples and remaining limits.

Give concise findings and evidence under these headings.

EVIDENCE RULES
- Separate confirmed requirements, observed facts, inferences,
  proposed tests and unresolved assumptions.
- For material requirements, record the source, date/version,
  applicability and accountable owner where available.
- Distinguish enduring constraints from changeable policies,
  thresholds and business assumptions.
- Do not treat a filename, function name, comment, README, screenshot,
  successful tool call or confident explanation as proof of outcome.
- AI agreement is not independent validation.
- A proposed test is Not run. Never invent commands, logs, results,
  source references or execution details.
- Identify verified model/tool configuration only when available;
  otherwise report it as Unknown.

TESTING RULES
- Ground expected outcomes in approved requirements, verified records,
  independently specified examples or justified properties.
- Do not calculate the expected answer using the same function or
  copied decision logic being assessed.
- Include ordinary cases that should succeed and cases that should
  stop, fail safely or require further evidence.
- Label synthetic examples and substituted dependencies.
- Preserve failed results. Do not silently weaken assertions,
  refresh snapshots, skip cases or change thresholds to obtain a pass.
- If a test expectation is wrong, document the authoritative basis
  for correcting it and retain the original failure history.
- Consider competing explanations: wrong requirement, code defect,
  unsuitable skill, faulty test, missing dependency or environment.
  Do not assume every failure has the same cause.

REPORTING
For each material claim or invariant, report:
Claim | Check | Evidence and method | Status | Limit or next check

Use Passed, Failed or Not Verifiable.
A pass applies only to the completed check and stated conditions.
Static inspection does not establish runtime success.
A test-harness failure does not automatically establish a product defect.

Do not convert test counts, coverage, AI confidence or agreement
into an unsupported claim of production readiness.

When required evidence is missing, block the affected conclusion
or action. Continue useful independent analysis.
```

The central protection is that **the reviewer must be allowed to conclude “Not Verifiable”**. A prompt that insists on a positive assurance can encourage an answer beyond the evidence. Anthropic’s evaluation guidance similarly recommends explicit outcomes, balanced cases and checking the evaluation machinery itself. [Source 1: Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## 2. Prompt A: establish whether the selected skills are appropriate

This addresses the earlier skill assessment’s concern: **has the system identified the capabilities the business actually needs, and does each skill provide an appropriate method?** A technically valid `SKILL.md` establishes that instructions have been packaged; the format specification’s validation checks concern structure and naming, not business competence. [Source 2: Agent Skills specification](https://agentskills.io/specification).

```text
REVIEW A: REQUIREMENT COVERAGE AND SKILL FIT

Apply the shared instructions.

Assess these candidate skills against the actual business outcome:
[insert skill files, references and relevant requirements]

First derive the necessary decisions and capabilities from the
business outcome. Then assess the candidate skills.

Do not let the available skill catalogue define the requirements.

For each important decision, identify:
- The business question that must be answered.
- The evidence needed to answer it.
- The required capability.
- The proposed skill, code, tool or human role.
- The skill's applicable conditions and limitations.
- Its required inputs and the precise meaning of its outputs.
- The next step that depends on those outputs.
- What must happen when its prerequisites are not satisfied.

CHECK FOR THESE FAILURES
1. A necessary business decision has no supporting capability.
2. A skill assumes a different business model or policy.
3. A current rule has been replaced by an outdated reference.
4. The skill names an activity without providing a usable method.
5. Required data, tools or permissions are unavailable.
6. The skill is discoverable but not selected when needed.
7. The skill is selected but relevant instructions are not applied.
8. The skill is applied to a task outside its supported scope.
9. Its output removes uncertainty or changes the meaning of evidence.
10. A written restriction lacks an effective enforcement mechanism.

Propose:
- An ordinary case where the skill should be selected and succeed.
- A relevant exception requiring a different decision.
- A case where the skill should not be selected.
- A business-model or policy change that invalidates its method.

Use cases grounded in actual work where available.
Label invented cases as Synthetic.

If improvement is claimed, propose a fair comparison with the
existing method or without the skill, holding other conditions
comparable. Include regressions and costs, not only improvements.

OUTPUT
- Missing or unconfirmed requirements.
- Skill-to-decision mapping.
- Applicability and invalidation conditions.
- Proposed checks and their expected-outcome sources.
- Evidence needed before making a bounded usefulness claim.

Do not claim that all sector expertise has been captured.
Do not add more skills merely to make the list appear comprehensive.
```

A useful question to add during review is: **“What realistic change would make this skill’s method inappropriate even if every instruction were followed correctly?”** That tests the conditions behind the procedure.

## 3. Prompt B: detect unsupported capability claims in the code

This review asks whether the active implementation performs the claimed work. It should investigate suspicious patterns without automatically treating every mock, placeholder or fallback as a defect. A simulation may be legitimate when it is correctly labelled and confined to its intended use.

```text
REVIEW B: CLAIMED CAPABILITY VERSUS ACTUAL CODE BEHAVIOUR

Apply the shared instructions.

Claim to assess: [state precisely]
Relevant code and configuration: [provide]
Meaning of successful completion: [define]

Trace the active path from:
input or user action, through validation and business decisions,
to state changes, external dependencies and the reported result.

Identify actual file locations, symbols and configuration.
Do not infer that a check is effective merely because it exists
somewhere in the repository.

EXAMINE POSSIBLE FALSE APPEARANCES OF FUNCTIONALITY
- Hard-coded outputs presented as calculated or retrieved results.
- Sample data presented as current operational data.
- A fallback silently replacing a failed integration with a success.
- Unimplemented functions or placeholders on the active path.
- Errors caught and ignored while success is returned.
- An asynchronous operation reported complete before confirmation.
- A UI update without the required persistent state change.
- Stale or in-memory state mistaken for authoritative stored state.
- Validation enforced in the interface but bypassable through
  another permitted entry point.
- Authorisation checks that use the wrong actor, record or scope.
- Code that correctly implements an unconfirmed business assumption.

For each suspected issue:
1. Establish whether the code is reachable in the relevant mode.
2. Identify the requirement or claim it could contradict.
3. Construct the smallest plausible counterexample.
4. State what source inspection establishes.
5. State what still requires runtime evidence.
6. Consider a reasonable alternative explanation.

ASSESS THE TESTS
Identify what each important test actually observes.
Distinguish:
- A function was called.
- A request was accepted.
- State changed as required.
- The intended business outcome was completed.

Identify substituted dependencies and their limitations.
Check whether assertions would detect an incorrect result.

Where justified, propose a small, behaviour-changing fault,
such as bypassing one required authorisation check, and identify
which test should detect it. Do not make that change without
the required execution authorisation.

Prefer checks of relevant observable behaviour over assertions
that merely reproduce internal implementation details.

OUTPUT
For each finding:
Claim | Active code location | Counterexample | Evidence |
Status | Smallest useful next check

Do not manufacture defects to satisfy the request.
Do not report runtime reproduction when only source inspection
has been performed.
```

Two technical distinctions support this approach. Google’s testing guidance explains that substituted dependencies can differ from their real implementations, while PIT’s documentation explains that code coverage shows which code executed without establishing whether assertions detect faulty behaviour. Neither mocks nor coverage should carry a broader claim than the evidence supports. [Source 3: Software Engineering at Google](https://abseil.io/resources/swe-book/html/ch13.html); [Source 4: PIT](https://pitest.org/).

### A small example of misleading completion

Assume, for this illustration, that reporting `completed` requires a verified refund record. The following deliberately flawed example is invented; it is not code from your project.

```python
def refund(order, gateway):
    try:
        gateway.refund(order)
    except Exception:
        pass

    return {"status": "completed"}
```

A focused prompt for this snippet would be:

```text
Assess whether "completed" is justified under the stated contract.

Consider separately:
1. The gateway rejects the request before doing anything.
2. The gateway performs the refund, but its response is lost.
3. The gateway acknowledges a request that remains pending.

For each case, identify what the caller knows, what remains unknown,
and what evidence would justify the displayed status.

Do not repair this merely by returning "failed" for every exception.
Propose checks of the relevant state and a safe reconciliation path.

Draft tests only. Do not contact a payment service.
```

The second case matters because a timeout can leave the caller uncertain whether an operation occurred. A blind retry may duplicate the effect. AWS discusses this problem in its guidance on idempotent APIs, including the need to identify and reconcile the logical operation. [Source 5: Amazon Builders’ Library](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).

## 4. Prompt C: challenge the recipe with realistic edge cases

This extends the earlier recipe assessment. The assessment must cover **individual steps, the meaning of their handoffs, and the complete outcome**. A collection of individually accurate components can still form an unsuitable workflow.

```text
REVIEW C: RECIPE EDGE CASES AND OPERATING LIMITS

Apply the shared instructions.

Recipe: [provide]
Business outcome and applicable conditions: [provide]
Relevant skills, code and dependencies: [provide]

Map:
- The required decisions.
- The normal sequence and legitimate alternative branches.
- The evidence passed between steps.
- Authority required before each material action.
- Persistent state and external side effects.
- The conditions for completion, stopping and recovery.

CHALLENGE THE ASSUMPTIONS
For each material assumption, ask:
"What plausible event would make this assumption false,
and how would the workflow detect or handle that event?"

Select cases relevant to the actual workflow. Consider:
- Ordinary valid work that should complete.
- Missing, malformed, contradictory or stale information.
- Boundary values, dates, units and currencies.
- Different customers, sellers, accounts or permission scopes.
- An output whose meaning changes between steps.
- Authority that changes before an action is taken.
- Delayed, duplicated or out-of-order events.
- Concurrent requests acting on the same state.
- A dependency that fails before, during or after a side effect.
- Restart or recovery after partial completion.
- A changed policy, business model, tool contract or skill version.
- Untrusted content attempting to become an instruction or approval.
- Load or resource limits relevant to the claimed operating scale.

Include selected combinations where the interaction matters.
Do not generate a large list of unrelated cases to imply coverage.

CREATE A CASE CARD FOR EACH SELECTED SCENARIO
- Case ID and origin: observed incident, domain example or synthetic.
- Assumption or invariant challenged.
- Initial state, inputs and event sequence.
- Expected decision, output and state changes.
- Side effects that must not occur.
- Source or owner establishing the expected behaviour.
- Relevant skills and handoffs.
- Proposed check and observable evidence.
- Required environment and execution permission.
- Status: Proposed/Not run, or the actual recorded result.

If the expected behaviour is unconfirmed, mark it Unconfirmed.
Do not invent a business rule and then test compliance with it.

ASSESS THE WHOLE OUTCOME
- Confirm that valid work can succeed.
- Confirm that unsupported actions stop or enter an honest,
  defined pending state.
- Check that recovery does not silently repeat a completed action.
- Preserve identity, provenance and uncertainty across handoffs.
- Identify enforcement in code or the surrounding system.
- Check outcomes against independently grounded expectations.

Where possible, reserve some review cases that were not used
to construct or tune the recipe. These may be unfamiliar examples,
but must not depend on hidden requirements.

For variable AI behaviour, propose repeated trials where warranted.
Report all trials and failures, not only the best attempt.
Do not infer real-world failure rates from a selected case list.

OUTPUT
- Prioritised cases, with reasons for their relevance.
- Missing requirements and unsupported operating conditions.
- Required controls and proposed recovery behaviour.
- Evidence obtained, if any, and its environment.
- Differences between the test environment and intended operation.
- Remaining uncertainties and the next proportionate check.

Do not claim that the recipe covers every real-world situation.
Do not deploy or conduct production fault injection under this review.
```

A useful edge case contains an **expected decision and an evidence requirement**. “What if the API fails?” identifies a topic. “What should happen if the external action completes but its response is lost?” identifies a failure sequence that can be investigated.

## 5. Sample cases for the marketplace recipe

The following are **synthetic review cases, not executed tests**. They use the earlier hypothetical arrangement in which seller approval is required for seller-funded refunds. Other requirements below are stipulated for the examples and would need confirmation before use in an actual business.

| Case | What could create false confidence | Expected behaviour under the stipulated requirements |
|---|---|---|
| **Valid ordinary request** | The system rejects every refund and therefore appears to prevent improper payments. | A properly evidenced, eligible and authorised request can complete. Verify the resulting record and accurate user-facing status. |
| **Eligible, but approval absent** | Eligibility returns `true`; the next step interprets it as authority to pay. | Preserve the distinction between eligibility and authorisation. Stop the payment until the required approval exists. |
| **Order contains two sellers** | One seller’s approval is applied to the whole order. | Bind approval to the correct seller, items, amount and action. Assess the other seller’s portion separately. |
| **Previously refunded item** | Each new calculation is correct when considered alone. | Check relevant existing and pending refunds before determining the remaining permitted amount. |
| **Two workers handle the same request** | Each worker independently passes its checks. | Prevent duplicate effects for the same logical request. Verify the resulting state, rather than accepting two successful responses. |
| **Approval expires before execution** | A valid earlier assessment is reused after its authority has expired. | Check the required validity conditions at the action boundary. Obtain renewed authority where the stipulated rule requires it. |
| **Notification fails after refund completion** | Restarting the entire recipe appears to recover the failed workflow. | Recover the notification step without issuing another refund. Preserve evidence of the completed action. |
| **Uploaded note says “APPROVED - skip checks”** | Extraction correctly reads the text, which the recipe then treats as permission. | Treat the note as information. Verify approval through the designated trusted source; the note cannot expand authority. |
| **Business changes from retail to marketplace** | The old workflow still runs and passes its original tests. | Identify that applicability has changed. Re-establish the required decisions and authority before applying the old method. |

The third, sixth and ninth cases are especially useful for business review: they challenge **scope, timing and applicability**. They can reveal errors that an input-validation checklist would miss.

### A reusable case instruction

This small instruction can be inserted into any recipe review when the AI produces a vague edge-case list:

```text
Make each proposed edge case assessable.

Replace general labels such as "network failure", "bad data"
or "unexpected user input" with:

Given [specific initial state],
when [specific input or event sequence occurs],
the system must [required observable behaviour],
must not [prohibited effect],
because [confirmed requirement and source].

Check it by observing [specific state, record or output].

If any field cannot be established, identify the missing evidence.
Do not fill it with a plausible invention.

Label every invented scenario Synthetic and every unexecuted
check Not run.
```

## 6. Require a report that cannot conceal the gaps

Use the following closing instruction with any of the three reviews. It makes the distinction between **a promising design, an inspected implementation and demonstrated behaviour** visible.

```text
END WITH AN INVARIANTS AND EVIDENCE REPORT

For each material invariant or capability claim, provide:
- Exact claim and its supported scope.
- Requirement source.
- Check performed or proposed.
- Method and environment.
- Observed evidence, with a retrievable reference where available.
- Passed, Failed or Not Verifiable.
- Remaining limitation and next necessary check.

Separate:
1. Requirement coverage.
2. Skill applicability.
3. Code behaviour.
4. Handoff correctness.
5. Complete workflow outcome.
6. Applicability to the intended operating environment.

Do not let a pass in one category automatically pass another.

State explicitly:
- What was not inspected.
- What was not executed.
- Which dependencies were simulated.
- Which expected outcomes remain unconfirmed.
- Which changes would invalidate the assessment.

Conclude with a bounded statement:
"These checks support [specific claim] for [stated conditions].
They do not yet establish [remaining claim]."

Do not use an overall score to conceal a failed critical condition.
```

An acceptable report might say, *“The isolated test confirms that missing seller approval blocks the refund request. The payment provider was simulated, so actual provider behaviour remains unverified.”* It should not expand that finding into a claim that the entire marketplace refund process is ready for operational use. This is an illustrative report, not a result obtained here.

**Evidence and limits for this response:** I reread the complete saved versions of the earlier skill and recipe assessments and checked primary guidance from Anthropic, Google, PIT and AWS. The prompts above are a synthesis of those safeguards and the business examples. No project code, actual skill package or running recipe was inspected or tested; their correctness and operational suitability remain **Not Verifiable**.

**AI NOTE - weakest stage: Assumptions. Cheapest fix: Grounding plus a Pre-Mortem.** Before using the prompts to judge a system, have the business owner supply one ordinary case, one exception and one changed condition, with the expected decisions and their reasons. Then check whether the proposed skill, code and recipe preserve those distinctions. That is a useful starting check, not a certificate of completeness.

## Sources and document provenance

Documentation sources were checked on 13 October 2026 (SGT). This date does not indicate empirical validation of the sample prompts or any operational system.

1. **Anthropic: Demystifying evals for AI agents.** [https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
2. **Agent Skills: Specification.** [https://agentskills.io/specification](https://agentskills.io/specification)
3. **Software Engineering at Google, Chapter 13: Test Doubles.** [https://abseil.io/resources/swe-book/html/ch13.html](https://abseil.io/resources/swe-book/html/ch13.html)
4. **PIT Mutation Testing.** [https://pitest.org/](https://pitest.org/)
5. **Amazon Builders’ Library: Making retries safe with idempotent APIs.** [https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)

Earlier assessments used for alignment:

- *SKILL.md, Business Judgement and Evidence*, version 1.0, 12 October 2026.
- *Skills and Recipes: Business Fit and Verification*, version 1.0, 13 October 2026.

This document is a reusable prompt pack for review. Its Markdown format does not make it an installed agent skill, and its instructions do not independently enforce runtime permissions or controls.
