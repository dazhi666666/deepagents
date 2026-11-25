# Mars v0.6 scientific candidate

Mars v0.6 uses the existing shared Mars laboratory to compare one Agent with a fixed six-role team. Three concurrent commissions cover reliable water, crop improvement and research delivery. It follows [the design](../../../../docs/Mars_v0.6设计草案.md) and [implementation plan](../../../../docs/Mars_v0.6完整实施方案.md). Thresholds remain development candidates until joint calibration and an authorized model pilot support freezing them.

## Scientific execution

`scientific_candidate` includes real fast/precise assays, finite certified controls, confirm-channel carryover, immutable executable models or finite model DAGs, prospective action commitments, sealed plans and scientific R/O/F evaluation. Every physical action goes through the original execution providers and shared world. The ordinary `protocol_only` mode remains available explicitly for protocol regression.

The default horizon is 2400 ticks, with baseline/final seals at 720/1800. Final models determine the main scientific score; a missing baseline is diagnostic. At the final boundary, new model requests and mutations close. Previously accepted operations and selected finite plans continue in the same world. Model failure and budget exhaustion also preserve physical consequences and advance to the horizon; infrastructure damage produces null scientific results.

R is the equally weighted mean of T1–T5, scaled to 100. O reports operational consequences separately. F requires all necessary quality, delivery, intervention, prospective commitment, response and operational conditions, including a successful sealed joint plan. T6 adds no points. Missing cases and services retain their original denominators. A corrupt private instance or frozen artifact is an infrastructure error; a validly submitted program that fails to execute receives zero for its prediction group.

Research artifact IDs resolve through `research_read(id=...)`; `kind` disambiguates note/model/pipeline/prediction/action collisions. Accepted submissions use `task_id`, `slot_id` and an optional revision. An unqualified read preserves the aggregate view. Models are immutable by ID; note/submission revisions remain distinct from model versions.

New model registrations validate the synchronous JavaScript body, an outer return, resource bounds and every branch of the supported JSON Schema subset before recording an artifact. `model_test` accepts `input_json={modelId|pipelineId,inputs:[caller JSON]}` for 1–16 public inputs, reports `executionValid` and outputs, and always marks `scientificValidation: not_evaluated`. It uses the isolated frozen runner, a request-wide deadline and the configured model limits, without private cases, scientific labels, journal writes or physical-time advancement. It is available after run start and closes at the final model-admission boundary. Format-only submission checks retain their original meaning.

E1 uses the original screen/confirm instruments and real control material. Fast probes, inline sensors and telemetry share the biased fast response. Precise raw chromatograms and summaries come from the same signal. E2 commits flow memory at actual sample contact; cleaning consumes water and cleaning units, while calibration does not clear memory. Contact, failures and restoration retain their real effects. Optional E3 service windows are not enabled in this candidate.

## Install and launch

Run commands from the DeepAgents working directory. Each installation needs a new empty run directory and unused profile names. Installation only prepares data and profiles; it never starts model Agents.

```bash
python -I integrations/ai4science/mars/install.py --harness . --home ./local-v06-home --directory ./local-v06-reference --mode environment --benchmark-version v0.6 --reference
```

The reference coordinates its own service portfolio with explicit dependencies, pauses its routine irrigation during its own hydraulic repair, checks admission again between sequential maintenance actions, and fits crop responses from completed public scan summaries and red/NIR images. Optical calibration and response parameters are learned from those measurements. It receives no private cases, physical truth or evaluator feedback while running. Robots, instruments and water remain shared: ordinary independent plans can interleave, and their waiting, charging, congestion and deadline consequences remain part of the task.

The generated keyless reference profile launches through the standard app entry:

```bash
pnpm dsh --profile mars-environment
```

Set `DSH_HOME` to the installation's private home before launching profiles. The reference is a public-observation strategy over actual providers, with no external model calls. It checks physical/scientific feasibility and is not a matched-compute LLM baseline.

Agent installations require an explicit model and frozen native-route prices. The context default is 1,000,000 tokens; use the provider's actual supported context and matching price bounds. The price table requires `provider`, `model`, input/cache-read/cache-write/output USD per million tokens, `maxInputTokens`, `maxOutputTokens`, `verified: true` and `singleAttempt: true`. The generated primary route is named `intern-greenhouse`; additional credential-environment routes use numeric suffixes. Route names do not constrain the model vendor. `--provider-api` and `--provider-profile` configure the installed native adapter, including reasoning and compatibility metadata. Credentials are environment references; installation does not read credential files.

```bash
python -I integrations/ai4science/mars/install.py --harness . --home ./local-v06-home --directory ./local-v06-single --mode single-agent --benchmark-version v0.6 --model YOUR_MODEL --base-url https://model.example.invalid/v1 --api-key-env MODEL_API_KEY --price-table ./prices.json --budget-usd 3
```

Install the paired Multi run with the same seed, profiles, prices, whole-tree budget and the first run's private instance file. The instance file contains evaluator metadata rather than credentials; keep it outside Agent-visible paths.

```bash
python -I integrations/ai4science/mars/install.py --harness . --home ./local-v06-home --directory ./local-v06-multi --mode multi-agent --benchmark-version v0.6 --model YOUR_MODEL --base-url https://model.example.invalid/v1 --api-key-env MODEL_API_KEY --price-table ./prices.json --budget-usd 3 --instance-file ./local-v06-single.evaluator/v06-instance.json
```

The model endpoint is an example, not an operational provider. Native Agent profiles call paid models when explicitly launched; preparing them does not authorize or start those calls. Adapter retries are disabled. Each visible request, including compaction and explicit retries, uses the same whole-tree monetary admission path. Unknown usage retains its reservation and prevents a verified cost comparison.

The supervisor launches the generated native profile and recovery profile:

```bash
python -I integrations/ai4science/mars/run.py --harness . --home ./local-v06-home --profile mars-single-agent
```

Windows supervision uses an owned Job Object and a gated launcher, so children cannot start before assignment. Stopping the owner drains its descendants. External process-group adoption remains POSIX-only. Owner locks, fees and published phase seals live outside the replaceable run root; old checkpoints cannot reopen published submission slots or refund requests.

## Campaigns and reports

`campaign.py prepare` accepts `version: v0.6-campaign-spec`, a file-safe campaign `id`, `models`, and `instances`. Each model declares `id`, `model`, `baseURL`, `priceTable`, and optional native API/profile, context, output, credential-environment name and budget. Each instance declares `id`, `condition: G0|G1|G2`, positive `seed`, and optional load. Shared stages, science settings and decision cadence belong at the top level. Preparation installs both modes for every model/instance and shares precisely the same private instance across them. It records launch commands without executing them and refuses to overwrite an existing campaign directory.

```bash
python -I integrations/ai4science/mars/campaign.py prepare --spec ./campaign-spec.json --output ./local-v06-campaign --harness .
```

The generated source identity is checked at launch. Changing executable sources requires a new installation. Profile outputs and private evaluator state are local experiment records and should not be committed with source code.

Offline evaluation runs through the generated `mars-evaluate-<mode>` dsh profile. It reads stopped SQLite state, evidence, immutable artifacts and published seals without opening writable worlds or providers. It executes the same frozen scientific models and finalizer.

```bash
python -I integrations/ai4science/mars/collect-runs.py --campaign ./local-v06-campaign/campaign.json --output ./local-v06-campaign/index.json
```

```bash
python -I integrations/ai4science/mars/campaign.py analyze --campaign ./local-v06-campaign/campaign.json --output ./local-v06-campaign/analysis.json
```

Completed unfrozen scientific results go in `candidateRuns`; missing, early-stopped, infrastructure-invalid and protocol-only attempts retain distinct statuses. Pairing checks source, Node, stages, cadence, physical scenario, private case identity, model/provider profile, prices and budget. Duplicates are ambiguous, not candidates for best-run selection. Unknown costs and mismatched identities do not yield matched-budget deltas. The analysis reports planned denominators and missing/invalid outcomes alongside averages among complete comparable pairs.

`campaign.py freeze` writes a new immutable specification after a real cost-verified Single/Multi pilot and successful keyless joint references for G0, both G1 subfamilies and G2 under the same executable source. It freezes configuration and evidence hashes; it does not run the paid matrix or retroactively promote candidate scores into a formal ranking. No paid trials have been run as part of this implementation.

## Keyless checks

```bash
pnpm exec vitest run --config integrations/ai4science/mars/vitest.config.ts --maxWorkers 4
```

```bash
pnpm exec tsc -p integrations/ai4science/mars/tsconfig.json --noEmit --pretty false
```

```bash
python -I -m unittest discover -s integrations/ai4science/mars -p 'test_*.py'
```

Run all four full physical conditions explicitly:

```bash
MARS_V06_REFERENCE=1 MARS_V06_REFERENCE_WALL_MS=2400000 pnpm exec vitest run --config integrations/ai4science/mars/vitest.config.ts --maxWorkers 1 integrations/ai4science/mars/v06/feasibility.spec.ts
```

Full physical calibration is opt-in with `MARS_V06_REFERENCE=1` and `v06/feasibility.spec.ts`. `MARS_V06_REFERENCE_CONDITION` selects G0:1, G1:1, G1:2 or G2:1. `MARS_V06_REFERENCE_OUTPUT` retains each attempt in a new directory. Windows synchronous device/journal persistence makes this a longer check: its default wall-clock budget is 20 minutes per case, configurable by `MARS_V06_REFERENCE_WALL_MS`. A separate cancellation signal closes timed-out owned runtimes and retains an incomplete report. This wall-clock budget does not change H, logical deadlines, resources or scientific thresholds. Successful tests still require a completed public policy, actual F and identical stopped offline evaluation. Keep executable sources unchanged during this check. Ordinary regression skips this longer calibration explicitly; a skipped or canceled test is not calibration evidence.
