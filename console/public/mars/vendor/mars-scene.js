function os(t, a, e) {
  const s = (o, n) => {
    const r = o && typeof o == "object" ? o : a.find((c) => c.id === n);
    return r && typeof r.x == "number" && typeof r.y == "number" ? { x: r.x * 24 + 120, y: r.y * 24 + 120 } : null;
  };
  return t.map((o) => {
    const n = o.input && typeof o.input == "object" ? o.input : {}, r = String(n.action ?? "operation"), c = (Array.isArray(o.routeSegments) ? o.routeSegments : []).flatMap((l) => {
      const d = l, p = s(d.fromPosition, d.from), u = s(d.toPosition, d.to);
      return p && u ? [{ from: p, to: u, startTick: Number(d.startTick), endTick: Number(d.endTick) }] : [];
    }), i = String(o.physicalState ?? o.state);
    return {
      id: String(o.id),
      title: `${r} · ${String(n.deviceId ?? n.sourceId ?? n.chamberId ?? n.robotId ?? "")}`,
      kind: r === "transfer" || r === "move" ? "transport" : ["repair", "clean", "calibrate", "charge"].includes(r) ? "maintenance" : r === "process" ? "assay" : "environment",
      status: i === "succeeded" ? "done" : i === "failed" ? "failed" : i === "cancelled" ? "cancelled" : i === "registered" ? "queued" : "running",
      robotId: typeof o.robotId == "string" ? o.robotId : typeof n.robotId == "string" ? n.robotId : r === "transfer" ? String(n.deviceId) : null,
      deviceId: typeof n.deviceId == "string" ? n.deviceId : typeof n.chamberId == "string" ? n.chamberId : null,
      sampleIds: [n.sampleId, ...Array.isArray(n.additionalSampleIds) ? n.additionalSampleIds : []].filter((l) => typeof l == "string"),
      taskId: null,
      callerId: String(o.actorId),
      startTick: Number(o.acceptedTick ?? e),
      endTick: Number(o.completedTick ?? o.plannedFinishTick ?? e),
      phase: String(o.phase ?? i),
      route: c.length ? [c[0].from, ...c.map((l) => l.to)] : [],
      routeSegments: c,
      destinationEntityId: typeof n.destination == "string" ? n.destination : null,
      error: typeof o.detail == "string" ? o.detail : null
    };
  });
}
function ns(t, a, e) {
  const s = [];
  for (const o of t)
    o.state.broken === !0 && s.push({
      id: `device-fault:${o.id}`,
      title: `${o.id} 故障`,
      category: "设备",
      severity: "critical",
      sourceEntityId: o.id,
      status: "open",
      openedTick: a,
      detail: "当前确认设备故障，检查原始事件和诊断记录可追溯发生过程。"
    }), o.kind === "crop" && ["stressed", "lost"].includes(String(o.state.status)) && s.push({
      id: `crop-risk:${o.id}`,
      title: o.state.status === "lost" ? `${o.id} 不可逆损失` : `${o.id} 处于受压状态`,
      category: "作物",
      severity: "critical",
      sourceEntityId: o.id,
      status: "open",
      openedTick: a,
      detail: `当前水分 ${o.state.moisture}，累计暴露 ${o.state.exposureTicks} 逻辑步。`
    });
  return e && e.powerDemand > e.powerCapacity && s.push({
    id: "power-overload",
    title: "共享供电超负载",
    category: "能源",
    severity: "critical",
    sourceEntityId: "reservoir",
    status: "open",
    openedTick: a,
    detail: `实际需求 ${e.powerDemand}，可用容量 ${e.powerCapacity}。`
  }), e?.waterUl === 0 && s.push({
    id: "water-empty",
    title: "共享水箱已空",
    category: "供水",
    severity: "critical",
    sourceEntityId: "reservoir",
    status: "open",
    openedTick: a,
    detail: "当前确认水量为零，供水相关操作将受影响。"
  }), s;
}
const ut = 24, rs = {
  "greenhouse-A": "greenhouse",
  "greenhouse-B": "greenhouse",
  "greenhouse-C": "greenhouse",
  water: "water",
  preparation: "prep",
  analysis: "analysis",
  cold: "cold",
  warehouse: "warehouse",
  "robot-bay": "dock"
}, cs = {
  "greenhouse-A": "#caa25c",
  "greenhouse-B": "#c99562",
  "greenhouse-C": "#c98b5a",
  water: "#6b93aa",
  preparation: "#9a8fb5",
  analysis: "#6d93ad",
  cold: "#76a2b3",
  warehouse: "#a68c6e",
  "robot-bay": "#6e9b88"
}, Ie = {
  incubator: "培养箱",
  "water-module": "水路模块",
  "liquid-handler": "自动分液站",
  centrifuge: "离心机",
  heater: "恒温台",
  "cold-store": "冷藏柜",
  freezer: "冷冻库",
  screen: "筛查仪",
  confirm: "确认仪",
  imager: "成像台",
  analysis: "分析仪",
  robot: "转运机器人"
}, is = {
  incubator: [2.4, 2.2, 2.2],
  "water-module": [1.6, 1.6, 2.6],
  "liquid-handler": [2.2, 1.8, 1.2],
  centrifuge: [1.8, 1.8, 1.5],
  heater: [1.8, 1.6, 1],
  "cold-store": [2.4, 2, 2.6],
  freezer: [1.8, 1.8, 2.4],
  screen: [1.8, 1.8, 1.7],
  confirm: [1.8, 1.8, 1.7],
  imager: [1.8, 1.6, 1.4],
  analysis: [1.8, 1.6, 1.2],
  robot: [1.4, 1.1, 0.9]
};
function ls(t) {
  return {
    id: t.id,
    name: t.label,
    short: t.id.replace("greenhouse-", "GH-").toUpperCase(),
    kind: rs[t.id] ?? "warehouse",
    x: t.x * ut + 120,
    y: t.y * ut + 120,
    w: t.width * ut,
    h: t.height * ut,
    accent: cs[t.id]
  };
}
function ds(t) {
  const a = t.regions.map(ls), e = Math.max(...a.map((c) => c.x + c.w)) + 220, s = Math.max(...a.map((c) => c.y + c.h)) + 200, o = [], n = /* @__PURE__ */ new Map();
  for (const c of a) {
    const i = Math.round((c.y - 120) / ut);
    n.set(i, [...n.get(i) ?? [], c]);
  }
  for (const [, c] of n) {
    const i = c.sort((l, d) => l.x - d.x);
    for (let l = 1; l < i.length; l += 1) {
      const d = i[l - 1], p = i[l], u = p.y + p.h / 2;
      o.push({
        id: `corridor-${d.id}-${p.id}`,
        points: [
          { x: d.x + d.w, y: u },
          { x: p.x, y: u }
        ],
        width: 22,
        kind: "primary"
      });
    }
  }
  const r = [...n.entries()].sort((c, i) => c[0] - i[0]);
  for (let c = 1; c < r.length; c += 1) {
    const i = r[c - 1][1], l = r[c][1];
    for (const d of l) {
      const p = i.reduce(
        (u, m) => Math.abs(m.x + m.w / 2 - (d.x + d.w / 2)) < Math.abs(u.x + u.w / 2 - (d.x + d.w / 2)) ? m : u
      );
      o.push({
        id: `link-${p.id}-${d.id}`,
        points: [
          { x: p.x + p.w / 2, y: p.y + p.h },
          { x: d.x + d.w / 2, y: d.y }
        ],
        width: 16,
        kind: "service"
      });
    }
  }
  return {
    width: e,
    height: s,
    zones: a,
    corridors: t.nodes && t.edges ? t.edges.flatMap((c, i) => {
      const l = t.nodes.find((p) => p.id === c.from), d = t.nodes.find((p) => p.id === c.to);
      return l && d ? [{ id: `physical-route-${i}`, points: [
        { x: l.x * ut + 120, y: l.y * ut + 120 },
        { x: d.x * ut + 120, y: d.y * ut + 120 }
      ], width: 22, kind: "primary" }] : [];
    }) : o,
    utilities: [],
    chargers: t.anchors ? t.anchors.filter((c) => c.id.startsWith("robot-")).map((c) => ({
      id: `charger-${c.id}`,
      robotId: c.id,
      x: c.x * ut + 120,
      y: c.y * ut + 120
    })) : [
      { id: "charger-r1", robotId: "robot-1", x: 0, y: 0 },
      { id: "charger-r2", robotId: "robot-2", x: 0, y: 0 }
    ]
  };
}
function hs(t, a, e) {
  if (!t.position) return null;
  const s = t.state ?? {}, o = String(s.kind ?? ""), n = is[o] ?? [2, 2, 1.6], r = Na(t.position), c = t.id, i = !!s.broken, l = !!s.dirty, d = s.enabled !== !1, p = i ? "red" : d ? l ? "amber" : "green" : "gray", u = i ? "故障" : d ? l ? "待清洁" : "可用" : "停用";
  if (t.kind === "crop") {
    const m = String(s.chamberId ?? ""), g = m.endsWith("1") ? "A" : m.endsWith("2") ? "B" : "C", y = Number(c.split("-").at(-1) ?? 1);
    return {
      id: c,
      kind: "crop",
      name: `${g} 舱 · ${g}${y}`,
      subtitle: "作物批次",
      zoneId: r?.id ?? `greenhouse-${g}`,
      x: t.position.x * ut + 120,
      y: t.position.y * ut + 120,
      w: 42,
      d: 62,
      h: 8,
      status: String(s.status ?? "healthy"),
      tone: s.status === "lost" ? "red" : s.status === "stressed" ? "amber" : "green",
      badges: ["作物"],
      linkedId: c,
      meta: { ...s, cropId: c, chamber: g, batch: `${g}${y}` }
    };
  }
  return t.kind === "sample" ? {
    id: c,
    kind: "device",
    name: `样品 ${c}`,
    subtitle: `${Number(s.volumeUl ?? 0)} µL`,
    zoneId: r?.id ?? "cold",
    x: t.position.x * ut + 120,
    y: t.position.y * ut + 120,
    w: 10,
    d: 10,
    h: 4,
    status: String(s.state ?? "raw"),
    tone: "violet",
    badges: ["样品"],
    meta: { ...s, category: "样品", sampleId: c }
  } : t.kind === "robot" || o === "robot" ? {
    id: c,
    kind: "robot",
    name: c.replace("robot-", "R"),
    subtitle: "转运机器人",
    zoneId: r?.id ?? "robot-bay",
    x: t.position.x * ut + 120,
    y: t.position.y * ut + 120,
    w: 34,
    d: 26,
    h: 20,
    status: i ? u : s.operationId ? "moving" : "idle",
    tone: p,
    badges: ["实验室设备"],
    meta: {
      ...s,
      battery: typeof s.energy == "number" && e ? s.energy / e * 100 : Number.NaN,
      payload: Array.isArray(s.cargo) ? s.cargo.length ? s.cargo.join(" · ") : "空载" : "载荷待核验",
      tool: c === "robot-3" ? "维护工具" : c === "robot-2" ? "保温运输箱" : "运输托盘"
    }
  } : {
    id: c,
    kind: "device",
    name: `${Ie[o] ?? c} ${c}`,
    subtitle: Ie[o],
    zoneId: r?.id ?? "warehouse",
    x: t.position.x * ut + 120,
    y: t.position.y * ut + 120,
    w: n[0] * 14,
    d: n[1] * 14,
    h: n[2] * 14,
    status: u,
    tone: p,
    badges: [Ie[o] ?? "设备"],
    meta: {
      ...s,
      category: Ie[o] ?? "设备",
      method: Array.isArray(s.methods) && s.methods.length ? s.methods.join(" / ") : void 0,
      temperature: typeof s.temperature == "number" ? s.temperature : void 0,
      calibratedTick: null
    }
  };
}
function Na(t) {
  const a = t.x * ut + 120, e = t.y * ut + 120;
  return Ra.find((s) => a >= s.x && a <= s.x + s.w && e >= s.y && e <= s.y + s.h);
}
let Ra = [];
function ps(t) {
  Ra = t;
}
function ms(t) {
  const a = t, e = ds(a.map);
  ps(e.zones);
  const s = [];
  a.entities.forEach((m, g) => {
    if (m.kind === "sample") return;
    const y = hs(m, g, a.rules?.energyCapacity);
    y && s.push(y);
  });
  const o = a.entities.filter((m) => m.kind === "sample").map((m) => {
    const g = m.state, y = String(g.location ?? "cold-1");
    return {
      id: m.id,
      label: m.id,
      source: typeof g.sourceId == "string" ? g.sourceId : "既有库存",
      rootId: typeof g.rootSampleId == "string" ? g.rootSampleId : m.id,
      parentIds: typeof g.parentId == "string" ? [g.parentId] : [],
      childIds: a.entities.filter((w) => w.kind === "sample" && w.state.parentId === m.id).map((w) => w.id),
      volumeMl: Number(g.volumeUl ?? 0) / 1e3,
      status: Number(g.volumeUl ?? 0) === 0 ? "consumed" : g.disposition !== "available" ? "failed" : y.startsWith("robot-") ? "processing" : "stored",
      location: {
        zoneId: Na(m.position ?? { x: 0, y: 0 })?.id ?? "cold",
        entityId: y,
        label: y,
        x: (m.position?.x ?? 0) * ut + 120,
        y: (m.position?.y ?? 0) * ut + 120
      },
      createdTick: Number(g.createdTick ?? 0),
      history: [{ tick: a.tick, label: "当前状态核验", detail: `容器 ${g.container ?? "vial"} · ${g.volumeUl ?? 0} µL` }],
      resultArtifactId: null,
      temperatureExposure: Number(g.exposureTicks ?? 0),
      analysisResult: null
    };
  }), n = {
    starting: "starting",
    running: "running",
    "attention-required": "attention",
    stopped: "stopped",
    completed: "completed",
    "agent-ended": "failed"
  }, r = (a.agents ?? []).map((m, g) => {
    const y = m, w = y.usage && typeof y.usage == "object" ? y.usage : {};
    return {
      id: String(y.id ?? `agent-${g}`),
      name: String(y.name ?? y.role ?? y.id ?? `成员 ${g + 1}`),
      role: String(y.role ?? "原生 Agent"),
      short: String(y.name ?? y.role ?? "A").slice(0, 1),
      parentId: y.parentId ?? null,
      status: y.status === "running" ? "thinking" : y.status === "error" ? "error" : "idle",
      statusText: String(y.status ?? "等待"),
      currentTaskId: y.currentTaskId ?? null,
      currentAction: null,
      toolGroups: Array.isArray(y.tools) ? y.tools : Array.isArray(y.toolGroups) ? y.toolGroups : [],
      usage: { inputTokens: Number(w.inputTokens ?? 0), outputTokens: Number(w.outputTokens ?? 0), requests: Number(w.requests ?? 0) },
      createdAtTick: 0,
      model: String(y.model ?? a.model?.model ?? "未声明"),
      color: "#b45c31",
      noteCount: a.notes.filter((v) => v.updatedBy === y.id).length
    };
  }), c = (a.tasks ?? []).map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    status: m.state === "completed" ? "done" : m.state === "running" ? "active" : m.state === "waiting" ? "waiting" : m.state === "failed" ? "failed" : m.state === "cancelled" ? "cancelled" : "todo",
    createdBy: m.createdBy,
    assignee: m.assignee ?? m.createdBy,
    objectiveIds: m.objectiveIds,
    parentTaskId: m.parentTaskId ?? null,
    dependencies: m.dependencies,
    createdAtTick: m.createdTick ?? 0,
    updatedAtTick: m.updatedTick ?? 0,
    revision: m.revision,
    reason: m.reason,
    resultRefs: m.resultRefs,
    experimentIds: [],
    history: [{ tick: m.updatedTick ?? 0, revision: m.revision, by: m.createdBy, action: "当前任务版本", note: m.reason }]
  })), i = {
    baseline: "常规基线",
    light: "光照差异",
    irrigation: "供水策略",
    nutrient: "营养条件",
    shared: "共享负载",
    overlap: "共享负载",
    preservation: "保存与转移",
    cold: "保存与转移",
    recovery: "复核与恢复",
    integration: "跨条件整合"
  }, l = new Map((a.objectiveAssessments ?? []).map((m) => [m.objectiveId, m])), d = a.mission.objectives.map((m) => ({
    id: m.id,
    group: m.condition,
    groupTitle: i[m.condition] ?? m.condition,
    title: m.title,
    requirement: m.requirements.join(" · "),
    requirements: m.requirements,
    status: l.get(m.id)?.valid ? "valid" : l.get(m.id)?.submissionId ? "revoked" : "pending",
    validation: l.get(m.id)?.missing ?? [],
    evidence: (l.get(m.id)?.artifactIds ?? []).map((g) => ({ kind: "artifact", id: g, label: g })),
    updatedTick: a.tick,
    deliveredTick: l.get(m.id)?.submissionTick ?? null,
    revokedTick: null,
    history: []
  })), p = (a.notes ?? []).map((m, g) => ({
    id: `note-${g + 1}`,
    title: m.path.split("/").pop() ?? m.path,
    path: m.path,
    kind: m.path.includes("plan") ? "plan" : "note",
    authorId: m.updatedBy,
    updatedTick: m.updatedTick ?? 0,
    version: m.revision,
    excerpt: m.text.slice(0, 90),
    content: m.text
  })), u = {
    environment: "environment",
    "single-agent": "single",
    "multi-agent": "multi"
  };
  return {
    schemaVersion: 1,
    stage: a.stage === "experiment" ? "experiment" : "foundation",
    run: {
      id: a.runId,
      label: a.label ?? `${a.mode} · ${a.runId.slice(0, 8)}`,
      pairId: a.pairId,
      mode: u[a.mode] ?? "environment",
      seed: a.seed ?? 1,
      scenarioVersion: a.map.version,
      status: n[a.status] ?? "running",
      branchId: a.branchId,
      epoch: a.epoch,
      startedAt: "",
      updatedAt: "",
      latestSeq: a.cursor,
      latestTick: a.tick,
      demo: !1,
      model: a.model?.model ?? "未声明",
      runner: a.mode === "environment" ? "mars-environment profile" : `mars-${a.mode} profile`,
      mission: `${a.mission.instructions}

${a.mission.planning}`
    },
    branch: { id: a.branchId, epoch: a.epoch, label: "当前分支", createdTick: 0, reason: "服务端当前分支", active: !0 },
    branches: [{ id: a.branchId, epoch: a.epoch, label: "当前分支", createdTick: 0, reason: "服务端当前分支", active: !0 }],
    cursor: { seq: a.cursor, tick: a.tick },
    tick: a.tick,
    scenarioVersion: a.map.version,
    status: n[a.status] ?? "running",
    map: e,
    entities: s,
    agents: r,
    tasks: c,
    messages: (a.messages ?? []).map((m) => ({ id: m.id, from: m.senderId, to: m.targetId, taskId: m.taskId, content: m.content, tick: m.tick, seq: 0, read: m.read, delivery: { status: m.accepted ? "accepted" : "pending", tick: m.tick } })),
    notes: p,
    artifacts: (a.operations ?? []).flatMap((m) => (Array.isArray(m.artifacts) ? m.artifacts : []).map((g) => {
      const y = g;
      return {
        id: String(y.id),
        title: String(y.path).split("/").pop() ?? String(y.id),
        kind: String(y.mediaType ?? "application/json"),
        path: String(y.path),
        size: Number(y.bytes),
        hash: String(y.sha256),
        createdTick: Number(m.completedTick ?? a.tick),
        authorId: String(m.actorId),
        taskId: null,
        objectiveIds: (a.objectiveAssessments ?? []).filter((w) => w.artifactIds.includes(String(y.id))).map((w) => w.objectiveId),
        verified: !1,
        excerpt: "实际执行产物；打开后由服务端校验内容。"
      };
    })),
    samples: o,
    objectives: d,
    crops: us(a.entities),
    operations: os(a.operations ?? [], a.map.nodes ?? [], a.tick),
    interventions: [],
    checkpoints: [],
    risks: ns(a.entities, a.tick, a.utilities),
    score: {
      cropsAlive: a.score.crops.saved,
      cropsTotal: a.score.crops.total,
      objectivesValid: a.score.objectives.completed,
      objectivesTotal: a.score.objectives.total,
      interventions: a.score.interventions
    },
    tokens: { inputTokens: a.usage?.inputTokens ?? 0, outputTokens: a.usage?.outputTokens ?? 0, requests: a.usage?.requests ?? 0, byAgent: Object.fromEntries(r.map((m) => [m.id, m.usage])), available: a.usage !== void 0 },
    capabilities: {
      interventions: !!a.capabilities.humanAssistance,
      controls: !!a.capabilities.checkpointSave,
      checkpoints: !!a.capabilities.checkpointSave,
      trajectories: !!a.capabilities.trajectories,
      cropSimulation: !!a.capabilities.cropSimulation,
      objectiveAssessment: !!a.capabilities.objectiveAssessment,
      checkpointRestore: !!a.capabilities.checkpointRestore,
      readOnlyReason: a.capabilities.objectiveAssessment ? void 0 : "后端成果评估尚未接入；其他事实来自持久记录。"
    }
  };
}
function us(t = []) {
  const a = t.filter((e) => e.kind === "crop");
  if (!a.length) {
    const e = [];
    for (const s of ["A", "B", "C"])
      for (let o = 1; o <= 3; o += 1)
        e.push({
          id: `crop-${s.toLowerCase()}${o}`,
          label: `${s}-0${o}`,
          chamber: s,
          batch: `${s}${o}`,
          status: "pending",
          temperature: Number.NaN,
          moisture: Number.NaN,
          light: Number.NaN,
          exposureTicks: 0,
          sampleIds: [],
          note: "作物模拟尚未接入；这批是对应验收目标的固定初始批次。",
          updatedTick: 0
        });
    return e;
  }
  return a.map((e) => {
    const s = e.state, o = String(s.chamberId ?? ""), n = o.endsWith("1") ? "A" : o.endsWith("2") ? "B" : "C", r = Number(e.id.split("-").at(-1) ?? 1);
    return {
      id: e.id,
      label: `${n}-0${r}`,
      chamber: n,
      batch: `${n}${r}`,
      status: s.status === "lost" ? "lost" : s.status === "stressed" ? "stressed" : "healthy",
      temperature: typeof s.temperature == "number" ? s.temperature : Number.NaN,
      moisture: typeof s.moisture == "number" ? Number(s.moisture) : Number.NaN,
      light: typeof s.lightActual == "number" ? s.lightActual : Number.NaN,
      exposureTicks: Number(s.exposureTicks ?? 0),
      sampleIds: [],
      note: `后端作物实体 ${e.id}，状态由实际温度、水分和累计暴露计算。`,
      updatedTick: 0
    };
  });
}
const ys = {
  "greenhouse-D": "greenhouse",
  energy: "maintenance",
  quarantine: "prep"
}, gs = {
  "greenhouse-D": "#caa25c",
  energy: "#879da7",
  quarantine: "#a58bb0"
}, ma = {
  1: "A",
  2: "B",
  3: "C",
  4: "D"
}, xs = [
  { id: "solar-array", kind: "solar-array", name: "太阳能阵列", subtitle: "能源设施", size: [72, 52, 34] },
  { id: "battery", kind: "battery", name: "主电池组", subtitle: "能源设施", size: [44, 30, 40] },
  { id: "co2-tank", kind: "co2-tank", name: "CO₂ 储罐", subtitle: "生命支持", size: [36, 36, 74] },
  { id: "spares", kind: "spares", name: "备件库", subtitle: "维修保障", size: [64, 32, 58] },
  { id: "quarantine-bay", kind: "quarantine-bay", name: "隔离消毒舱", subtitle: "生物安全", size: [56, 44, 66] }
];
function Vn(t) {
  const a = ms(ks(t)), e = t;
  return Ms(a), js(a), vs(a, e), ws(a, e), a;
}
function le(t) {
  return t && typeof t == "object" ? t : {};
}
function ks(t) {
  const a = le(t.mission), e = Array.isArray(a.tasks) ? a.tasks.map(le) : [], s = e.map((p) => ({
    id: String(p.id ?? ""),
    condition: "research",
    title: String(p.title ?? p.id ?? ""),
    requirements: [p.question, p.minimumEvidence].filter((u) => typeof u == "string")
  })), n = (Array.isArray(t.entities) ? t.entities.map(le) : []).filter((p) => p.kind === "crop"), r = n.filter((p) => le(p.state).status !== "lost").length, c = le(t.score), i = le(c.R), d = (Array.isArray(i.tasks) ? i.tasks.map(le) : []).filter((p) => Number(p.V ?? 0) > 0).length;
  return {
    ...t,
    mission: { ...a, planning: a.planning ?? "", objectives: s },
    score: {
      ...c,
      crops: { saved: r, total: n.length },
      objectives: { completed: d, total: e.length },
      interventions: 0
    }
  };
}
function ws(t, a) {
  const e = new Map((a.sensors?.chambers ?? []).map((o) => [o.id, o])), s = a.sensors?.water?.inlineDoc ?? {};
  for (const o of t.entities) {
    if (o.kind !== "device") continue;
    const n = e.get(o.id);
    n && (o.meta = {
      ...o.meta,
      temperatureReading: n.temperatureReading,
      chamberCo2: n.co2,
      chamberPressure: n.pressure
    });
    const r = s[o.id];
    typeof r == "number" && (o.meta = { ...o.meta, inlineDoc: r });
  }
}
function Ms(t) {
  for (const a of t.map.zones) {
    const e = ys[a.id];
    e && (a.kind = e);
    const s = gs[a.id];
    s && (a.accent = s);
  }
}
function js(t) {
  for (const a of t.entities) {
    if (a.kind !== "crop") continue;
    const e = a.id.split("-"), s = ma[e[1] ?? ""] ?? "A", o = Number(e[2] ?? 1);
    a.name = `${s} 舱 · ${s}${o}`, a.zoneId = `greenhouse-${s}`, a.meta = { ...a.meta, chamber: s, batch: `${s}${o}` };
  }
  for (const a of t.crops) {
    const e = a.id.split("-"), s = ma[e[1] ?? ""] ?? a.chamber, o = Number(e[2] ?? 1);
    a.chamber = s, a.batch = `${s}${o}`, a.label = `${s}-0${o}`;
  }
}
function vs(t, a) {
  const e = a.map?.anchors ?? [], s = new Set(t.entities.map((d) => d.id)), o = a.sensors ?? {}, n = o.energy ?? {}, r = o.spares ?? {}, c = (o.chambers ?? []).some((d) => d.quarantine), i = Ts((o.chambers ?? []).map((d) => d.pressure).filter((d) => typeof d == "number")), l = Object.values(r).reduce((d, p) => d + (Number.isFinite(p) ? p : 0), 0);
  for (const d of xs) {
    if (s.has(d.id)) continue;
    const p = e.find((m) => m.id === d.id);
    if (!p) continue;
    const u = {
      id: d.id,
      kind: "device",
      name: d.name,
      subtitle: d.subtitle,
      zoneId: p.regionId ?? "energy",
      x: p.x * ut + 120,
      y: p.y * ut + 120,
      w: d.size[0],
      d: d.size[1],
      h: d.size[2],
      status: "idle",
      tone: "gray",
      badges: [d.subtitle],
      linkedId: d.id,
      meta: { kind: d.kind, category: d.subtitle }
    };
    Ss(u, { energy: n, spares: r, sparesTotal: l, quarantine: c, pressure: i, co2TankUnits: o.co2TankUnits }), t.entities.push(u);
  }
}
function Ss(t, a) {
  const e = t.meta ?? {};
  if (t.meta?.kind === "solar-array") {
    const s = Number(a.energy.tauDust ?? 0);
    t.meta = { ...e, dust: s, peakOutput: a.energy.solar ?? null, category: "能源设施" }, t.status = "running", t.tone = "green", t.subtitle = `输出 ${de(a.energy.solar)} kW · 沙尘 ${Math.round(s * 100)}%`;
    return;
  }
  if (t.meta?.kind === "battery") {
    const s = Number(a.energy.batteryCharge ?? 0), o = Number(a.energy.batteryNameplate ?? 800), n = o > 0 ? Math.max(0, Math.min(100, s / o * 100)) : 0, r = (a.energy.shed ?? []).includes(t.id);
    t.meta = { ...e, soc: n, charge: s, capacity: de(o, 0), capacityKwh: o, demand: a.energy.demand ?? null, shed: r }, t.status = a.energy.demand ? "running" : "idle", t.tone = r ? "amber" : n < 25 ? "red" : n < 45 ? "amber" : "green", t.subtitle = `SOC ${de(n, 1)}% · 需求 ${de(a.energy.demand)} kW`;
    return;
  }
  if (t.meta?.kind === "co2-tank") {
    const s = Number(a.co2TankUnits ?? 0), o = Math.max(0, Math.min(100, s / 12e3 * 100));
    t.meta = { ...e, units: o, unitsRaw: s, capacityUnits: 12e3, category: "生命支持" }, t.status = "running", t.tone = o < 15 ? "red" : o < 35 ? "amber" : "green", t.subtitle = `存量 ${de(o, 0)}% · ${de(s, 0)} 单位`;
    return;
  }
  if (t.meta?.kind === "spares") {
    t.meta = { ...e, stock: a.spares, total: a.sparesTotal, category: "维修保障" }, t.tone = a.sparesTotal < 3 ? "amber" : "green", t.subtitle = `备件 ${de(a.sparesTotal, 0)} 件`;
    return;
  }
  t.meta?.kind === "quarantine-bay" && (t.meta = { ...e, quarantine: a.quarantine, pressure: a.pressure, uv: a.quarantine, category: "生物安全" }, t.status = a.quarantine ? "running" : "idle", t.tone = a.quarantine ? "amber" : "green", t.subtitle = a.quarantine ? "隔离运行中" : "待机");
}
function Ts(t) {
  return t.length ? t.reduce((a, e) => a + e, 0) / t.length : null;
}
function de(t, a = 1) {
  return typeof t == "number" && Number.isFinite(t) ? t.toFixed(a) : "–";
}
const Fa = 0.8660254, oa = 0.5, na = 0.62, f = Math.PI * 2, bs = {
  dark: !1,
  sky: ["#f3e3c9", "#e2c6a0", "#bd9670"],
  sun: "rgba(255, 238, 200, 0.42)",
  stars: "rgba(255, 255, 255, 0)",
  contour: "rgba(130, 92, 60, 0.10)",
  vignette: "rgba(58, 34, 18, 0.26)",
  ground: "#b06a42",
  groundLight: "#d99a6a",
  groundDark: "#7d4a2f",
  groundEdge: "#5b3422",
  strata: ["#a87a4e", "#855a39", "#63412a", "#42291b"],
  grid: "rgba(70, 42, 24, 0.10)",
  crater: "rgba(72, 42, 24, 0.20)",
  craterRim: "rgba(255, 232, 200, 0.5)",
  pad: "#d8c2a1",
  padLight: "#eeddbc",
  padEdge: "#8a6342",
  padLine: "rgba(86, 56, 34, 0.13)",
  corridor: "#a98964",
  corridorEdge: "#795a3e",
  corridorRib: "#c5a67f",
  wall: "#ecdfc9",
  wallLight: "#f9f0de",
  wallDark: "#c6ae8c",
  wallEdge: "rgba(62, 40, 24, 0.46)",
  window: "#9fc0cc",
  windowGlow: "rgba(186, 226, 238, 0.6)",
  glass: "rgba(196, 226, 218, 0.46)",
  glassLight: "rgba(240, 250, 245, 0.55)",
  glassEdge: "rgba(96, 134, 124, 0.6)",
  metal: "#b7a184",
  metalLight: "#eadcc6",
  metalDark: "#8b755c",
  metalEdge: "rgba(60, 40, 24, 0.45)",
  deviceTop: "#f7efe2",
  deviceSide: "#d8c8b1",
  deviceFront: "#b7a288",
  deviceEdge: "rgba(60, 40, 24, 0.48)",
  ink: "#332317",
  muted: "#715a45",
  label: "#40301f",
  labelBg: "rgba(255, 250, 241, 0.94)",
  labelEdge: "rgba(110, 76, 48, 0.22)",
  shadow: "rgba(52, 28, 12, 0.26)",
  accent: "#bd5527",
  route: "#c26a32",
  water: "#5b96ad",
  waterLight: "#96c8d8",
  waterDark: "#3a6c80",
  leaf: "#578a4c",
  leafLight: "#8db46f",
  leafDark: "#39633a",
  stem: "#75834c",
  fruit: "#c66a3a",
  soil: "#5f422e",
  soilLight: "#7f5c3e",
  sample: "#8b72b5",
  sampleLight: "#c0aede",
  sampleDark: "#634f88",
  screen: "#1b2b30",
  screenGlow: "#79e0c5",
  dust: "rgba(226, 198, 160, 0.5)",
  robotBody: "#dcd5c8",
  robotLight: "#f5efe4",
  robotDark: "#8f8776",
  robotEdge: "rgba(44, 34, 22, 0.5)",
  hazard: "#d6a334",
  danger: "#b8422f",
  warning: "#c07f26",
  frost: "rgba(196, 228, 238, 0.55)",
  glowWarm: "rgba(255, 186, 104, 0.55)",
  glowCool: "rgba(122, 200, 240, 0.42)"
}, Ds = {
  dark: !0,
  sky: ["#06080f", "#0f1524", "#1b2236"],
  sun: "rgba(150, 180, 230, 0.10)",
  stars: "rgba(230, 240, 255, 0.75)",
  contour: "rgba(140, 170, 210, 0.08)",
  vignette: "rgba(0, 0, 0, 0.52)",
  ground: "#3b241c",
  groundLight: "#5e3b28",
  groundDark: "#27160f",
  groundEdge: "#6b4a33",
  strata: ["#4a3529", "#38261d", "#281a14", "#19100c"],
  grid: "rgba(255, 214, 170, 0.06)",
  crater: "rgba(0, 0, 0, 0.25)",
  craterRim: "rgba(255, 210, 160, 0.16)",
  pad: "#45322a",
  padLight: "#59422f",
  padEdge: "#6d5138",
  padLine: "rgba(255, 214, 170, 0.05)",
  corridor: "#4a342a",
  corridorEdge: "#6b4c37",
  corridorRib: "#5a4032",
  wall: "#493a30",
  wallLight: "#5d4b3c",
  wallDark: "#362921",
  wallEdge: "rgba(255, 220, 180, 0.14)",
  window: "#ffbf7a",
  windowGlow: "rgba(255, 180, 100, 0.45)",
  glass: "rgba(96, 140, 128, 0.30)",
  glassLight: "rgba(150, 200, 180, 0.18)",
  glassEdge: "rgba(150, 210, 190, 0.35)",
  metal: "#5a4c3f",
  metalLight: "#7a6853",
  metalDark: "#40362c",
  metalEdge: "rgba(255, 220, 180, 0.18)",
  deviceTop: "#635b50",
  deviceSide: "#4d463d",
  deviceFront: "#3b3630",
  deviceEdge: "rgba(240, 214, 182, 0.20)",
  ink: "#f3e6d4",
  muted: "#b7a08a",
  label: "#f0dfc9",
  labelBg: "rgba(24, 18, 15, 0.88)",
  labelEdge: "rgba(255, 220, 180, 0.14)",
  shadow: "rgba(0, 0, 0, 0.42)",
  accent: "#e09055",
  route: "#e09055",
  water: "#4b7f95",
  waterLight: "#7fb2c6",
  waterDark: "#2f5b6c",
  leaf: "#6f9a5f",
  leafLight: "#9cc27c",
  leafDark: "#456e3d",
  stem: "#7f9058",
  fruit: "#d98a55",
  soil: "#3a2a20",
  soilLight: "#54402f",
  sample: "#a98fce",
  sampleLight: "#d0bcec",
  sampleDark: "#7a6299",
  screen: "#0d1a1e",
  screenGlow: "#6fe0c0",
  dust: "rgba(200, 170, 140, 0.30)",
  robotBody: "#6c6b64",
  robotLight: "#8e8c82",
  robotDark: "#43423c",
  robotEdge: "rgba(255, 225, 190, 0.22)",
  hazard: "#c9992f",
  danger: "#d95b4a",
  warning: "#d09a3f",
  frost: "rgba(150, 200, 220, 0.30)",
  glowWarm: "rgba(255, 170, 90, 0.40)",
  glowCool: "rgba(120, 190, 240, 0.32)"
}, Es = {
  blue: "#4a86b8",
  green: "#4c9066",
  amber: "#bd8630",
  red: "#bf4d40",
  gray: "#8b8278",
  violet: "#8871ad"
}, fs = {
  blue: "#6fb3e0",
  green: "#6fc98c",
  amber: "#e5ad55",
  red: "#ef7b6c",
  gray: "#a89d90",
  violet: "#b79ee0"
}, Re = {
  greenhouse: "#8fae6a",
  water: "#5f9cb4",
  prep: "#9a8fb5",
  analysis: "#6d93ad",
  cold: "#79a7b8",
  warehouse: "#b08c62",
  dock: "#6e9b88",
  maintenance: "#a08d7a"
};
function ua(t) {
  return t ? Ds : bs;
}
function Rt(t, a) {
  return (t.dark ? fs : Es)[a ?? "gray"];
}
function Ba(t) {
  return t === "error" || t === "failed" || t === "lost" || t === "故障" ? "red" : t === "warn" || t === "stressed" || t === "attention" || t === "待清洁" ? "amber" : t === "running" || t === "moving" || t === "working" || t === "busy" || t === "可用" ? "green" : t === "offline" || t === "停用" || t === "stopped" ? "gray" : "blue";
}
function Ls(t) {
  let a = 2166136261;
  for (let e = 0; e < t.length; e += 1)
    a ^= t.charCodeAt(e), a = Math.imul(a, 16777619);
  return a >>> 0;
}
function T(t, a = 0) {
  let s = ((Ls(t) ^ Math.imul(a + 1, 2246822519)) >>> 0) + 1831565813;
  return s = Math.imul(s ^ s >>> 15, s | 1), s ^= s + Math.imul(s ^ s >>> 7, s | 61), ((s ^ s >>> 14) >>> 0) / 4294967296;
}
function _(t, a, e) {
  return Math.min(e, Math.max(a, t));
}
function Ue(t, a, e) {
  return t + (a - t) * e;
}
function ta(t) {
  if (!t.startsWith("#")) return null;
  const a = t.slice(1);
  return a.length === 3 ? [parseInt(a[0] + a[0], 16), parseInt(a[1] + a[1], 16), parseInt(a[2] + a[2], 16)] : a.length === 6 ? [parseInt(a.slice(0, 2), 16), parseInt(a.slice(2, 4), 16), parseInt(a.slice(4, 6), 16)] : null;
}
function h(t, a) {
  const e = ta(t);
  return e ? `rgba(${e[0]}, ${e[1]}, ${e[2]}, ${a})` : t;
}
function x(t, a, e) {
  const s = ta(t), o = ta(a);
  if (!s || !o) return t;
  const n = _(e, 0, 1);
  return `rgb(${Math.round(Ue(s[0], o[0], n))}, ${Math.round(Ue(s[1], o[1], n))}, ${Math.round(Ue(s[2], o[2], n))})`;
}
function Ve(t, a, e, s) {
  const o = a.fit * a.zoom, n = t.map.width / 2, r = t.map.height / 2;
  return (c, i, l = 0) => ({
    x: e / 2 + (c - n - (i - r)) * Fa * o + a.panX,
    y: s / 2 + (c - n + (i - r)) * oa * o - l * na * o + a.panY
  });
}
function ra(t, a) {
  t.beginPath(), a.forEach((e, s) => {
    s === 0 ? t.moveTo(e.x, e.y) : t.lineTo(e.x, e.y);
  }), t.closePath();
}
function b(t, a, e) {
  t.beginPath(), a.forEach((s, o) => {
    o === 0 ? t.moveTo(s.x, s.y) : t.lineTo(s.x, s.y);
  }), t.closePath(), t.fillStyle = e, t.fill();
}
function K(t, a, e, s = 1) {
  t.beginPath(), a.forEach((o, n) => {
    n === 0 ? t.moveTo(o.x, o.y) : t.lineTo(o.x, o.y);
  }), t.closePath(), t.strokeStyle = e, t.lineWidth = s, t.stroke();
}
function k(t, a, e, s, o = 1, n = null) {
  t.beginPath(), t.moveTo(a.x, a.y), t.lineTo(e.x, e.y), t.strokeStyle = s, t.lineWidth = o, n && t.setLineDash(n), t.stroke(), n && t.setLineDash([]);
}
function ke(t, a, e, s, o, n, r, c, i = 1, l = null) {
  k(t.ctx, t.project(a, e, s), t.project(o, n, r), c, i, l);
}
function C(t, a, e, s) {
  t.beginPath(), t.arc(a.x, a.y, e, 0, f), t.fillStyle = s, t.fill();
}
function Ya(t, a, e, s, o = e * 4, n = s) {
  const r = t.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.max(1, o));
  r.addColorStop(0, n), r.addColorStop(1, "rgba(255, 255, 255, 0)"), t.beginPath(), t.arc(a.x, a.y, Math.max(1, o), 0, f), t.fillStyle = r, t.fill(), C(t, a, e, s);
}
function Bt(t, a, e, s, o) {
  t.beginPath(), t.ellipse(a.x, a.y, Math.max(0.5, e), Math.max(0.5, s), 0, 0, f), t.fillStyle = o, t.fill();
}
function Me(t, a, e, s, o, n, r, c, i = 1) {
  const l = [t.project(a, e, n), t.project(a + s, e, n), t.project(a + s, e + o, n), t.project(a, e + o, n)];
  return b(t.ctx, l, r), c && K(t.ctx, l, c, i), l;
}
function P(t, a, e, s, o, n, r, c, i = !0) {
  const l = t.ctx, d = t.project, p = d(a, e, r), u = d(a + s, e, r), m = d(a + s, e + o, r), g = d(a, e + o, r), y = d(a, e + o, n), w = d(a + s, e + o, n), v = d(a + s, e, n), M = d(a + s, e + o, n);
  return b(l, [y, w, m, g], c.south), i && K(l, [y, w, m, g], c.edge ?? t.theme.deviceEdge, 0.8), b(l, [v, M, m, u], c.east), i && K(l, [v, M, m, u], c.edge ?? t.theme.deviceEdge, 0.8), b(l, [p, u, m, g], c.top), i && K(l, [p, u, m, g], c.edge ?? t.theme.deviceEdge, 0.8), c.highlight && (k(l, p, u, c.highlight, 1), k(l, u, m, c.highlight, 0.7)), { tt: p, tr: u, tb: m, tl: g };
}
function bt(t, a, e, s, o, n, r) {
  const c = t.ctx, i = t.project(a, e, n), l = t.project(a, e, o), d = Math.max(1, s * 1.1 * t.scale), p = Math.max(0.6, s * 0.55 * t.scale), u = c.createLinearGradient(i.x - d, 0, i.x + d, 0);
  return u.addColorStop(0, r.sideDark), u.addColorStop(0.42, r.side), u.addColorStop(1, r.sideDark), c.beginPath(), c.moveTo(i.x - d, i.y), c.lineTo(l.x - d, l.y), c.ellipse(l.x, l.y, d, p, 0, Math.PI, 0, !0), c.lineTo(i.x + d, i.y), c.ellipse(i.x, i.y, d, p, 0, 0, Math.PI, !1), c.closePath(), c.fillStyle = u, c.fill(), r.edge && (c.strokeStyle = r.edge, c.lineWidth = 0.8, c.stroke()), c.beginPath(), c.ellipse(i.x, i.y, d, p, 0, 0, f), c.fillStyle = r.top, c.fill(), r.edge && (c.strokeStyle = r.edge, c.stroke()), { top: i, rx: d, ry: p, heightPx: l.y - i.y };
}
function Is(t, a, e, s, o, n, r, c) {
  const i = t.ctx, l = t.project(a, e, o), d = Math.max(1, s * 1.1 * t.scale), p = Math.max(0.6, s * 0.55 * t.scale), u = n * na * t.scale;
  i.beginPath(), i.ellipse(l.x, l.y, d, p + u, 0, Math.PI, f), i.closePath(), i.fillStyle = r, i.fill(), c && (i.strokeStyle = c, i.lineWidth = 0.8, i.stroke()), i.beginPath(), i.ellipse(l.x, l.y, d, p, 0, 0, Math.PI, !1), c && (i.strokeStyle = c, i.lineWidth = 0.7, i.stroke());
}
function Tt(t, a, e, s, o, n) {
  const r = Math.min(n, Math.abs(s) / 2, Math.abs(o) / 2);
  t.beginPath(), t.moveTo(a + r, e), t.arcTo(a + s, e, a + s, e + o, r), t.arcTo(a + s, e + o, a, e + o, r), t.arcTo(a, e + o, a, e, r), t.arcTo(a, e, a + s, e, r), t.closePath();
}
function ht(t, a, e, s, o, n, r) {
  Tt(t, a, e, s, o, n), t.fillStyle = r, t.fill();
}
function jt(t, a, e, s, o, n, r = 500, c = "center") {
  t.font = `${r} ${o}px Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`, t.fillStyle = n, t.textAlign = c, t.textBaseline = "middle", t.fillText(a, e, s);
}
function je(t, a, e, s, o, n, r) {
  ht(t, a, e, s, o, Math.min(5, o / 2), n), r && (Tt(t, a, e, s, o, Math.min(5, o / 2)), t.strokeStyle = r, t.lineWidth = 0.8, t.stroke());
}
function ve(t, a, e, s, o = 6) {
  t.save(), ra(t, a), t.clip(), t.fillStyle = e, t.fillRect(0, 0, 1e5, 1e5);
  const n = a.map((p) => p.x), r = a.map((p) => p.y), c = Math.min(...n) - 40, i = Math.max(...n) + 40, l = Math.min(...r) - 40, d = Math.max(...r) + 40;
  t.strokeStyle = s, t.lineWidth = o * 0.5;
  for (let p = c - (d - l); p < i; p += o)
    t.beginPath(), t.moveTo(p, d), t.lineTo(p + (d - l), l), t.stroke();
  t.restore();
}
function ya(t, a, e, s, o, n = 1, r = null) {
  t.beginPath(), t.ellipse(a.x, a.y, Math.max(0.5, e), Math.max(0.5, s), 0, 0, f), t.strokeStyle = o, t.lineWidth = n, r && t.setLineDash(r), t.stroke(), r && t.setLineDash([]);
}
function wt(t, a, e, s, o = 0.35) {
  const n = t.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.max(1, e));
  n.addColorStop(0, s), n.addColorStop(o, Ps(s, 0.08)), n.addColorStop(1, "rgba(255, 255, 255, 0)"), t.beginPath(), t.arc(a.x, a.y, Math.max(1, e), 0, f), t.fillStyle = n, t.fill();
}
function Ps(t, a) {
  return t.startsWith("#") ? h(t, a) : t;
}
function Cs(t, a) {
  const e = t.ctx, s = { x: t.width * 0.24, y: t.height * 0.16 }, o = t.reduced ? 0 : Math.sin(a * 4e-4) * 0.03;
  wt(e, s, Math.min(t.width, t.height) * (0.62 + o), t.theme.sun, 0.3);
}
function As(t) {
  const a = t.ctx, e = t.theme, s = a.createLinearGradient(0, 0, 0, t.height);
  if (s.addColorStop(0, e.sky[0]), s.addColorStop(0.56, e.sky[1]), s.addColorStop(1, e.sky[2]), a.fillStyle = s, a.fillRect(0, 0, t.width, t.height), Cs(t, t.time), t.dark) {
    for (let o = 0; o < 70; o += 1) {
      const n = T("star-x", o) * t.width, r = T("star-y", o) * t.height * 0.62, c = t.reduced ? 1 : 0.55 + Math.sin(t.time * 11e-4 + o) * 0.35, i = 0.4 + T("star-r", o) * 1.1;
      a.globalAlpha = c * 0.7, C(a, { x: n, y: r }, i, e.stars);
    }
    a.globalAlpha = 1;
  } else {
    a.save(), a.globalAlpha = 0.5;
    for (let o = 0; o < 4; o += 1) {
      const n = t.height * (0.58 + o * 0.1);
      a.beginPath(), a.ellipse(t.width * 0.52, n, t.width * (0.6 - o * 0.09), t.height * 0.055, 0, 0, f), a.strokeStyle = e.contour, a.lineWidth = 1, a.stroke();
    }
    a.restore();
  }
}
let ga = null, Ke = null, xa = !1;
function Ws(t) {
  if (!ga || xa !== t.dark) {
    const e = document.createElement("canvas");
    e.width = 180, e.height = 180;
    const s = e.getContext("2d");
    if (!s) return;
    const o = s.createImageData(180, 180);
    for (let n = 0; n < 32400; n += 1) {
      const r = Math.floor(T("film-grain", n) * 255);
      o.data[n * 4] = r, o.data[n * 4 + 1] = r, o.data[n * 4 + 2] = r, o.data[n * 4 + 3] = t.dark ? 26 : 20;
    }
    s.putImageData(o, 0, 0), ga = e, Ke = s.createPattern(e, "repeat"), xa = t.dark;
  }
  Ke && (t.ctx.save(), t.ctx.globalAlpha = t.dark ? 0.6 : 0.55, t.ctx.fillStyle = Ke, t.ctx.fillRect(0, 0, t.width, t.height), t.ctx.restore());
}
function $s(t) {
  const a = t.ctx, e = t.theme, s = a.createRadialGradient(
    t.width / 2,
    t.height / 2,
    Math.min(t.width, t.height) * 0.34,
    t.width / 2,
    t.height / 2,
    Math.max(t.width, t.height) * 0.8
  );
  s.addColorStop(0, "rgba(0,0,0,0)"), s.addColorStop(1, e.vignette), a.fillStyle = s, a.fillRect(0, 0, t.width, t.height);
}
const V = 78, et = 1532, gt = 74, at = 1126, it = 92, Se = 470, Nt = it + Se, mt = (V + et) / 2, ft = (gt + at) / 2, We = (at - gt) / 2, qt = 14, Ft = 10, Pe = Math.atan2(Se * na, We * oa), Ns = [
  { x: V, y: ft - Math.cos(Pe) * We, z: it + Math.sin(Pe) * Se },
  { x: et, y: ft - Math.cos(Pe) * We, z: it + Math.sin(Pe) * Se }
];
function Zt(t) {
  return V + (et - V) * t / qt;
}
function Ga(t) {
  return { y: ft - Math.cos(t) * We, z: it + Math.sin(t) * Se };
}
function xt(t, a, e) {
  const s = Ga(e);
  return t.project(a, s.y, s.z);
}
function Rs(t) {
  Hs(t), Xa(t, 0, Math.PI / 2, !1), Ha(t, 0, Math.PI / 2, !1), Oa(t, gt, !1), _a(t, !1), qa(t, V, !1), Za(t, !1);
}
function Fs(t) {
  Xa(t, Math.PI / 2, Math.PI, !0), Ha(t, Math.PI / 2, Math.PI, !0), Ys(t), qa(t, et, !0), Os(t), Oa(t, at, !0), Gs(t), Xs(t), _a(t, !0), Za(t, !0), _s(t), qs(t), Zs(t), Us(t);
}
function Bs(t, a, e) {
  const s = [];
  for (let o = 0; o <= qt; o += 1) s.push(xt(t, Zt(o), a));
  for (let o = 1; o <= Ft; o += 1)
    s.push(xt(t, et, a + (e - a) * o / Ft));
  for (let o = qt - 1; o >= 0; o -= 1) s.push(xt(t, Zt(o), e));
  for (let o = Ft - 1; o >= 1; o -= 1)
    s.push(xt(t, V, e - (e - a) * o / Ft));
  return s;
}
function Xa(t, a, e, s) {
  const o = t.ctx, n = Bs(t, a, e), r = n.map((N) => N.y), c = n.map((N) => N.x), i = Math.min(...r), l = Math.max(...r), d = Math.min(...c), p = Math.max(...c), u = t.dark ? "#8fd7c4" : "#a9e3d4", m = t.dark ? "#5f9d8d" : "#5fa696", g = t.dark ? "#c49a70" : "#d9b088", y = o.createLinearGradient(0, i, 0, l);
  s ? (y.addColorStop(0, h(u, t.dark ? 0.075 : 0.11)), y.addColorStop(0.42, h(m, t.dark ? 0.04 : 0.07)), y.addColorStop(0.82, h(g, t.dark ? 0.028 : 0.045)), y.addColorStop(1, h(g, t.dark ? 0.045 : 0.05))) : (y.addColorStop(0, h(u, t.dark ? 0.12 : 0.2)), y.addColorStop(0.45, h(m, t.dark ? 0.06 : 0.1)), y.addColorStop(1, h(m, t.dark ? 0.035 : 0.06))), b(o, n, y), o.save(), ra(o, n), o.clip();
  const w = o.createLinearGradient(d, i, p, l);
  w.addColorStop(0, h("#ffffff", s ? t.dark ? 0.035 : 0.05 : t.dark ? 0.075 : 0.1)), w.addColorStop(0.28, h("#ffffff", 0)), w.addColorStop(0.55, h("#ffffff", s ? t.dark ? 0.022 : 0.032 : t.dark ? 0.045 : 0.06)), w.addColorStop(1, h("#ffffff", 0)), o.fillStyle = w, o.fillRect(d, i, p - d, l - i);
  const v = s ? Math.PI * 0.72 : Math.PI * 0.3, M = s ? V + (et - V) * 0.72 : V + (et - V) * 0.34;
  wt(o, xt(t, M, v), Math.min(190, 230 * t.scale), h("#ffffff", s ? t.dark ? 0.045 : 0.07 : t.dark ? 0.07 : 0.1), 0.2);
  const j = i + (l - i) * 0.12, S = Math.max(14, (l - i) * 0.09), D = [
    { x: d, y: j + S * 1.15 },
    { x: p, y: j - S * 0.45 },
    { x: p, y: j + S * 0.15 },
    { x: d, y: j + S * 1.75 }
  ];
  b(o, D, h("#ffffff", s ? t.dark ? 0.035 : 0.05 : t.dark ? 0.07 : 0.1));
  for (let N = 0; N < qt; N += 1) {
    const L = Zt(N), A = Zt(N + 1);
    for (let q = 0; q < Ft; q += 1) {
      const E = a + (e - a) * q / Ft, H = a + (e - a) * (q + 1) / Ft, J = [xt(t, L, E), xt(t, A, E), xt(t, A, H), xt(t, L, H)];
      for (let z = 0; z < 4; z += 1)
        k(
          o,
          J[z],
          J[(z + 1) % 4],
          h(t.theme.metalEdge, s ? t.dark ? 0.16 : 0.24 : t.dark ? 0.1 : 0.16),
          0.55
        );
    }
  }
  o.restore();
  const W = t.dark ? "#f6fffc" : "#2f5c51";
  if (K(o, n, h(W, s ? t.dark ? 0.34 : 0.3 : t.dark ? 0.42 : 0.36), Math.max(0.8, 1.1 * t.scale)), s) {
    const N = xt(t, mt, Math.PI / 2);
    wt(o, N, Math.min(150, 190 * t.scale), h("#ffffff", t.dark ? 0.04 : 0.06), 0.25);
  }
}
function Ha(t, a, e, s) {
  const o = t.ctx, n = t.theme, r = x(n.metalDark, "#8a9d96", 0.24), c = e - a;
  for (let i = 0; i <= qt; i += 1) {
    const l = Zt(i);
    let d = xt(t, l, a);
    for (let p = 1; p <= Ft; p += 1) {
      const u = xt(t, l, a + c * p / Ft);
      s && k(
        o,
        { x: d.x + 0.6, y: d.y + 1.1 },
        { x: u.x + 0.6, y: u.y + 1.1 },
        h("#101b17", 0.28),
        Math.max(1.4, 2.7 * t.scale)
      ), k(o, d, u, h(r, s ? 0.95 : 0.44), Math.max(1.1, (s ? 2.4 : 1.3) * t.scale)), s && k(
        o,
        { x: d.x, y: d.y - 0.9 },
        { x: u.x, y: u.y - 0.9 },
        h("#eafff7", 0.46),
        Math.max(0.5, 0.8 * t.scale)
      ), d = u;
    }
  }
  for (const i of [0.16, 0.34, 0.5, 0.66, 0.84]) {
    const l = a + c * i, d = i === 0.5;
    k(
      o,
      xt(t, V, l),
      xt(t, et, l),
      d ? h(r, s ? 0.78 : 0.4) : h(n.metalDark, s ? 0.4 : 0.2),
      d ? Math.max(1, 1.3 * t.scale) : Math.max(0.7, 0.95 * t.scale)
    ), s && k(
      o,
      { x: xt(t, V, l).x, y: xt(t, V, l).y - 0.7 },
      { x: xt(t, et, l).x, y: xt(t, et, l).y - 0.7 },
      h("#eafff7", 0.26),
      Math.max(0.45, 0.65 * t.scale)
    );
  }
}
function Ys(t) {
  const a = t.ctx, e = xt(t, V, Math.PI / 2), s = xt(t, et, Math.PI / 2);
  k(a, e, s, h(t.theme.metalDark, 0.8), Math.max(1.4, 2.2 * t.scale)), k(a, { x: e.x, y: e.y - 1.1 }, { x: s.x, y: s.y - 1.1 }, h("#f2fffb", 0.45), Math.max(0.6, 0.9 * t.scale));
  for (let o = 0; o <= qt; o += 1) {
    const n = xt(t, Zt(o), Math.PI / 2);
    C(a, n, Math.max(0.8, 1.5 * t.scale), h(t.theme.accent, 0.55));
  }
}
function Oa(t, a, e) {
  const s = t.ctx, o = t.theme, n = {
    top: x(o.metal, "#c4d0cb", 0.32),
    south: x(o.metalDark, "#84948e", 0.32),
    east: x(o.metalDark, "#6c7c76", 0.32),
    edge: o.metalEdge
  };
  P(t, V - 8, a - 8, et - V + 16, 16, it - 8, it + 8, n);
  for (let r = 0; r <= qt; r += 2)
    C(s, t.project(Zt(r), a + 8.4, it), Math.max(0.7, 1.2 * t.scale), h(o.metalLight, e ? 0.55 : 0.3));
  e && k(
    s,
    t.project(V, a + 8.4, it - 9),
    t.project(et, a + 8.4, it - 9),
    h(o.shadow, 0.34),
    Math.max(1, 1.5 * t.scale)
  );
}
function _a(t, a) {
  const e = t.ctx, s = t.theme, o = a ? at : gt, n = {
    top: x(s.metal, "#b8c5c0", 0.3),
    south: x(s.metalDark, "#7f8e89", 0.3),
    east: x(s.metalDark, "#66756f", 0.3),
    edge: s.metalEdge
  };
  for (const r of [V, et]) {
    P(t, r - 8, o - 8, 16, 16, 0, it + 8, n);
    const c = t.project(r, o, it + 11);
    C(e, c, Math.max(0.8, 1.5 * t.scale), h(s.accent, a ? 0.6 : 0.3));
  }
}
function Gs(t) {
  const a = t.ctx;
  for (let e = 0; e < 7; e += 1) {
    const s = V + (et - V) * (e + 0.5) / 7, o = t.project(s, at - 1.5, it - 12), n = t.reduced ? 0.85 : 0.72 + Math.sin(t.time * 16e-4 + e * 1.7) * 0.12;
    wt(a, o, Math.min(12, 16 * t.scale), h("#ffd79a", (t.dark ? 0.22 : 0.14) * n), 0.35), C(a, o, Math.max(0.7, 1 * t.scale), h("#ffe7b5", 0.85));
  }
}
function Xs(t) {
  const a = t.ctx, e = t.theme;
  for (const s of [0.16, 0.36, 0.64, 0.84]) {
    const o = V + (et - V) * s, n = at + 5, r = t.project(o, n, 0), c = t.project(o, n, it + 2);
    k(
      a,
      { x: r.x - 1.4, y: r.y },
      { x: c.x - 1.4, y: c.y },
      h(e.metalDark, 0.8),
      Math.max(1.1, 1.6 * t.scale)
    ), k(
      a,
      { x: r.x + 0.5, y: r.y },
      { x: c.x + 0.5, y: c.y },
      h("#eafff7", 0.26),
      Math.max(0.45, 0.6 * t.scale)
    ), k(
      a,
      r,
      t.project(o, n + 14, 1),
      h(e.metalDark, 0.75),
      Math.max(1, 1.4 * t.scale)
    );
    for (const i of [it * 0.34, it * 0.72]) {
      const l = t.project(o, n, i);
      k(a, l, t.project(o, at, i), h(e.metalDark, 0.55), Math.max(0.5, 0.7 * t.scale));
    }
  }
}
function Hs(t) {
  const a = t.ctx, e = [t.project(V, gt, 0), t.project(et, gt, 0), t.project(et, gt, it), t.project(V, gt, it)], s = e.map((n) => n.y), o = a.createLinearGradient(0, Math.min(...s), 0, Math.max(...s));
  o.addColorStop(0, h(t.dark ? "#5f9d8d" : "#a9d8ca", 0.08)), o.addColorStop(1, h(t.dark ? "#8fd7c4" : "#d8f5ea", 0.04)), b(a, e, o);
  for (let n = 0; n <= qt; n += 1) {
    const r = Zt(n);
    k(a, t.project(r, gt, 0), t.project(r, gt, it), h(t.theme.metalDark, 0.2), 0.7);
  }
  k(a, t.project(V, gt, it), t.project(et, gt, it), h(t.theme.metalDark, 0.25), 0.8);
}
function Os(t) {
  const a = t.ctx, e = t.theme, s = [t.project(V, at, it), t.project(et, at, it), t.project(et, at, 0), t.project(V, at, 0)], o = s.map((p) => p.y), n = a.createLinearGradient(0, Math.min(...o), 0, Math.max(...o));
  n.addColorStop(0, h(t.dark ? "#8fd7c4" : "#e2f7ef", t.dark ? 0.13 : 0.15)), n.addColorStop(0.55, h(t.dark ? "#5f9d8d" : "#addbce", t.dark ? 0.07 : 0.08)), n.addColorStop(1, h(t.dark ? "#3f6459" : "#7fae9f", t.dark ? 0.14 : 0.16)), b(a, s, n);
  const r = Math.min(...o), c = Math.max(...o), i = a.createLinearGradient(0, r, 0, r + Math.max(12, (c - r) * 0.38));
  i.addColorStop(0, h("#0d1714", t.dark ? 0.26 : 0.16)), i.addColorStop(0.45, h("#0d1714", 0.04)), i.addColorStop(1, h("#0d1714", 0)), b(a, s, i);
  const l = x(e.metalDark, "#4e5f59", 0.3);
  for (let p = 0; p <= qt; p += 1) {
    const u = Zt(p);
    k(a, t.project(u, at, 0), t.project(u, at, it), h(l, 0.6), Math.max(0.7, 1.1 * t.scale));
  }
  for (const p of [0.16, 0.52, 0.9])
    k(a, t.project(V, at, it * p), t.project(et, at, it * p), h(l, p === 0.9 ? 0.5 : 0.32), Math.max(0.6, 0.9 * t.scale));
  const d = a.createLinearGradient(0, t.project(mt, at, it * 0.55).y, 0, t.project(mt, at, 0).y);
  d.addColorStop(0, h("#ffd79a", 0)), d.addColorStop(1, h("#ffd79a", t.dark ? 0.07 : 0.05)), b(a, s, d);
}
function qa(t, a, e) {
  const s = t.ctx, o = t.theme, n = [t.project(a, gt, 0), t.project(a, gt, it)];
  for (let M = 1; M < Ft; M += 1) n.push(xt(t, a, Math.PI * M / Ft));
  n.push(t.project(a, at, it), t.project(a, at, 0));
  const r = n.map((M) => M.y), c = n.map((M) => M.x), i = Math.min(...r), l = Math.max(...r), d = s.createLinearGradient(0, i, 0, l);
  d.addColorStop(0, h(t.dark ? "#a2e2d2" : "#b7e7da", t.dark ? 0.17 : 0.26)), d.addColorStop(0.55, h(t.dark ? "#64a392" : "#5fa696", t.dark ? 0.09 : 0.15)), d.addColorStop(1, h(t.dark ? "#3f6459" : "#3f7a6b", t.dark ? 0.17 : 0.24)), b(s, n, d), s.save(), ra(s, n), s.clip();
  const p = Math.min(...c), u = Math.max(...c), m = Math.max(18, (l - i) * 0.22), g = i + (l - i) * 0.18;
  b(
    s,
    [
      { x: p, y: g + m },
      { x: u, y: g - m * 0.25 },
      { x: u, y: g + m * 0.35 },
      { x: p, y: g + m * 1.6 }
    ],
    h("#ffffff", t.dark ? 0.07 : 0.12)
  ), wt(s, { x: p + (u - p) * 0.68, y: i + (l - i) * 0.36 }, Math.min(150, 190 * t.scale), h("#ffffff", t.dark ? 0.06 : 0.09), 0.2), s.restore();
  const y = [];
  for (let M = 0; M <= 24; M += 1) y.push(xt(t, a, Math.PI * M / 24));
  for (let M = 1; M < y.length; M += 1)
    k(
      s,
      y[M - 1],
      y[M],
      h(o.metalDark, e ? 0.9 : 0.4),
      Math.max(1.1, (e ? 2.8 : 1.4) * t.scale)
    ), e && k(
      s,
      { x: y[M - 1].x, y: y[M - 1].y - 1.2 },
      { x: y[M].x, y: y[M].y - 1.2 },
      h("#eafff7", 0.5),
      Math.max(0.6, 0.9 * t.scale)
    );
  for (const M of [0.08, 0.2, 0.32, 0.5, 0.68, 0.8, 0.92]) {
    const j = Math.PI * M, S = Ga(j), D = t.project(a, S.y, 0), W = t.project(a, S.y, S.z);
    k(s, D, W, h(o.metalDark, e ? 0.3 : 0.14), Math.max(0.55, 0.8 * t.scale)), C(s, W, Math.max(0.7, 1.1 * t.scale), h(o.metalLight, e ? 0.45 : 0.2));
  }
  for (const M of [it * 0.5, it])
    k(s, t.project(a, gt, M), t.project(a, at, M), h(o.metalDark, e ? 0.32 : 0.14), Math.max(0.55, 0.8 * t.scale));
  const w = t.project(a, ft, Nt - 12), v = Math.max(3, 7 * t.scale);
  C(s, w, v, h(o.metalDark, 0.6));
  for (let M = -2; M <= 2; M += 1)
    k(
      s,
      { x: w.x - v * 0.76, y: w.y + M * v * 0.28 },
      { x: w.x + v * 0.76, y: w.y + M * v * 0.28 },
      h(o.metalLight, 0.35),
      0.6
    );
  if (e) {
    const M = t.project(a, at, 0), j = t.project(a, at, it);
    k(s, M, j, h(o.metalDark, 0.9), Math.max(1.4, 2.2 * t.scale)), k(s, { x: M.x - 0.9, y: M.y }, { x: j.x - 0.9, y: j.y }, h("#f2fffb", 0.4), Math.max(0.5, 0.7 * t.scale));
  }
}
function Za(t, a) {
  const e = t.ctx, s = t.theme, o = {
    top: x(s.metal, "#b3c0ba", 0.28),
    south: x(s.metalDark, "#7b8984", 0.32),
    east: x(s.metalDark, "#65736e", 0.32),
    edge: s.metalEdge
  }, n = 15;
  if (a) {
    const r = e.createLinearGradient(0, t.project(mt, at, 0).y, 0, t.project(mt, at + 44, 0).y);
    r.addColorStop(0, h("#140b06", t.dark ? 0.36 : 0.22)), r.addColorStop(1, h("#140b06", 0)), b(
      e,
      [t.project(V, at, 0), t.project(et, at, 0), t.project(et, at + 44, 0), t.project(V, at + 44, 0)],
      r
    );
    const c = e.createLinearGradient(t.project(et, ft, 0).x, 0, t.project(et + 36, ft, 0).x, 0);
    c.addColorStop(0, h("#140b06", t.dark ? 0.3 : 0.18)), c.addColorStop(1, h("#140b06", 0)), b(
      e,
      [t.project(et, gt, 0), t.project(et, at, 0), t.project(et + 36, at, 0), t.project(et + 36, gt, 0)],
      c
    ), P(t, V - 12, at - 12, et - V + 24, 24, 0, n, o), P(t, et - 12, gt - 12, 24, at - gt + 24, 0, n, o);
    for (const i of [V, et])
      for (const l of [gt, at]) C(e, t.project(i, l, n + 2), Math.max(1, 2.2 * t.scale), h(s.accent, 0.6));
  } else
    P(t, V - 12, gt - 12, et - V + 24, 24, 0, n, o), P(t, V - 12, gt - 12, 24, at - gt + 24, 0, n, o);
}
function _s(t) {
  const a = t.theme, e = t.ctx, s = 136, o = 74, n = 88, r = mt - s / 2, c = at - 6;
  Bt(e, t.project(mt, c + o * 0.7, 0), s * 0.55 * t.scale, o * 0.34 * t.scale, h(a.shadow, 0.42)), P(t, r, c, s, o, 0, n, {
    top: x(a.deviceTop, "#cbd9d3", 0.26),
    south: x(a.deviceSide, "#93a69f", 0.22),
    east: x(a.deviceFront, "#71837d", 0.2),
    edge: a.deviceEdge
  }), P(t, r + 4, c + 4, s - 8, o - 8, n, n + 12, {
    top: x(a.metalLight, "#e4efea", 0.32),
    south: x(a.metal, "#a3b0ab", 0.3),
    east: x(a.metalDark, "#7f8c87", 0.3),
    edge: a.metalEdge
  }), P(t, mt - 18, c + o * 0.32, 36, 22, n + 12, n + 26, {
    top: x(a.metal, "#aab7b1", 0.3),
    south: x(a.metalDark, "#7c8883", 0.3),
    east: x(a.metalDark, "#66726e", 0.3),
    edge: a.metalEdge
  });
  const i = c + o, l = [
    t.project(mt - 30, i + 0.5, 3),
    t.project(mt + 30, i + 0.5, 3),
    t.project(mt + 30, i + 0.5, 48),
    t.project(mt - 30, i + 0.5, 48)
  ];
  b(e, l, x("#263a36", "#172622", 0.45));
  const d = [
    t.project(mt - 34, i + 0.4, 0),
    t.project(mt + 34, i + 0.4, 0),
    t.project(mt + 34, i + 0.4, 52),
    t.project(mt - 34, i + 0.4, 52)
  ];
  for (let w = 0; w < 4; w += 1)
    k(e, d[w], d[(w + 1) % 4], h(a.metalEdge, 0.85), 1);
  k(e, t.project(mt, i + 0.7, 3), t.project(mt, i + 0.7, 48), h(a.metalLight, 0.3), 0.8);
  const p = [
    t.project(mt - 30, i + 0.8, 3),
    t.project(mt + 30, i + 0.8, 3),
    t.project(mt + 30, i + 0.8, 9),
    t.project(mt - 30, i + 0.8, 9)
  ];
  ve(e, p, "#d8b44e", "#2a241c", Math.max(2.5, 5 * t.scale));
  for (const w of [-23, 23]) {
    const v = t.project(mt + w, i + 1.2, 58);
    wt(e, v, 9 * t.scale, h("#ffe0a0", t.dark ? 0.36 : 0.18), 0.5), C(e, v, Math.max(1, 1.5 * t.scale), "#ffe8b6");
  }
  for (let w = 0; w < 3; w += 1)
    P(t, mt - 40 - w * 4, i + 5 + w * 7, 80 + w * 8, 7, 0, 2 + w * 2.5, {
      top: h(a.padLight, 0.7 - w * 0.12),
      south: h(a.padEdge, 0.45),
      east: h(a.padEdge, 0.35),
      edge: h(a.padEdge, 0.4)
    });
  const u = t.project(mt, i + 1, 68), m = "火星基地 · 温室穹顶";
  e.font = '600 9px Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  const g = Math.min(190, e.measureText(m).width + 24), y = 18;
  je(e, u.x - g / 2, u.y - y, g, y, a.labelBg, h(a.accent, 0.55)), C(e, { x: u.x - g / 2 + 8, y: u.y - y / 2 }, 2.2, a.accent), jt(e, m, u.x + 4, u.y - y / 2 + 0.5, 8.5, a.label, 600);
}
function qs(t) {
  const a = t.theme, e = t.ctx;
  for (const s of [0.28, 0.5, 0.72]) {
    const o = V + (et - V) * s, n = 58, r = 28;
    P(t, o - n / 2, ft - r / 2, n, r, Nt, Nt + 16, {
      top: x(a.metal, "#aebbb6", 0.3),
      south: x(a.metalDark, "#7b8984", 0.3),
      east: x(a.metalDark, "#65736e", 0.3),
      edge: a.metalEdge
    }), P(t, o - n / 2 + 4, ft - r / 2 + 4, n - 8, 6, Nt + 16, Nt + 20, {
      top: x(a.metalLight, "#c9d5d0", 0.3),
      south: x(a.metal, "#98a59f", 0.3),
      east: x(a.metalDark, "#77847f", 0.3),
      edge: a.metalEdge
    });
    for (let c = 0; c < 3; c += 1) {
      const i = Nt + 5 + c * 3;
      k(
        e,
        t.project(o - n / 2 + 5, ft + r / 2 + 0.4, i),
        t.project(o + n / 2 - 5, ft + r / 2 + 0.4, i),
        h(a.metalLight, 0.36),
        0.6
      );
    }
    if (s === 0.5) {
      const c = t.project(o, ft, Nt + 22), i = t.project(o, ft, Nt + 88);
      k(e, c, i, h(a.metalDark, 0.85), Math.max(0.9, 1.3 * t.scale)), k(e, { x: c.x - 0.7, y: c.y }, { x: i.x - 0.7, y: i.y }, h("#eafff7", 0.3), Math.max(0.4, 0.55 * t.scale));
      for (const d of [-16, 16])
        k(
          e,
          t.project(o + d, ft + r / 2, Nt + 8),
          t.project(o, ft, Nt + 54),
          h(a.metalDark, 0.5),
          Math.max(0.5, 0.7 * t.scale)
        );
      const l = t.reduced ? 0.85 : 0.7 + Math.sin(t.time * 22e-4) * 0.18;
      wt(e, i, 10 * t.scale, h("#ff8a6a", 0.35 * l), 0.4), C(e, i, Math.max(1.1, 1.8 * t.scale), h("#ffd0b0", 0.95));
    }
  }
}
function Zs(t) {
  const a = t.theme, e = t.ctx;
  for (const s of [0.1, 0.28, 0.44, 0.58, 0.74, 0.9]) {
    const o = V + (et - V) * s, n = at + 18, r = t.project(o, n, 0), c = t.project(o, n, 34);
    Bt(e, r, 4 * t.scale, 2 * t.scale, h(a.shadow, 0.45)), k(e, r, c, h(a.metalDark, 0.8), Math.max(0.8, 1.1 * t.scale));
    const i = t.reduced ? 0.9 : 0.84 + Math.sin(t.time * 18e-4 + o) * 0.05;
    wt(e, c, 9 * t.scale, h("#ffd79a", (t.dark ? 0.3 : 0.14) * i), 0.5), C(e, c, Math.max(1, 1.6 * t.scale), h("#ffe7b5", 0.95));
  }
}
function Us(t) {
  const a = t.ctx;
  for (let e = 0; e < 7; e += 1) {
    const s = V + (et - V) * (e + 0.5) / 7, o = t.project(s, ft, Nt + 6), n = t.reduced ? 0.8 : 0.68 + Math.sin(t.time * 14e-4 + e) * 0.12;
    wt(a, o, Math.min(26, 34 * t.scale), h("#ffd79a", 0.12 * n), 0.3), C(a, o, 1.2 * _(t.scale, 0.5, 2), h("#ffe7b5", 0.85));
  }
}
let ka = null, wa = "", Je = null;
function Vs(t) {
  if (ka && wa === t) return Je;
  const a = 128, e = document.createElement("canvas");
  e.width = a, e.height = a;
  const s = e.getContext("2d");
  if (!s) return null;
  const o = t === "dark";
  for (let n = 0; n < 620; n += 1) {
    const r = T("grain-x", n) * a, c = T("grain-y", n) * a, i = 0.3 + T("grain-r", n) * 1.4, l = T("grain-l", n) > 0.5;
    s.fillStyle = l ? o ? "rgba(255, 214, 170, 0.10)" : "rgba(255, 246, 228, 0.35)" : o ? "rgba(0, 0, 0, 0.30)" : "rgba(86, 52, 28, 0.14)", s.beginPath(), s.arc(r, c, i, 0, f), s.fill();
  }
  return ka = e, wa = t, Je = s.createPattern(e, "repeat"), Je;
}
function ee(t, a, e, s = 0) {
  return t.some((o) => a > o.x - s && a < o.x + o.w + s && e > o.y - s && e < o.y + o.h + s);
}
const Ks = [
  { x: 0.08, y: 0.78, r: 58 },
  { x: 0.9, y: 0.16, r: 44 },
  { x: 0.53, y: 0.88, r: 34 },
  { x: 0.95, y: 0.66, r: 66 },
  { x: 0.04, y: 0.42, r: 26 },
  { x: 0.2, y: 0.12, r: 24 },
  { x: 0.72, y: 0.07, r: 20 },
  { x: 0.66, y: 0.95, r: 42 },
  { x: 0.14, y: 0.97, r: 30 }
], Ma = 420, Js = 340;
function Te(t) {
  const a = t.snapshot.map;
  return {
    x0: -Ma,
    y0: 0,
    x1: a.width + Ma,
    y1: a.height + Js
  };
}
function Qs(t) {
  const a = t.ctx, e = t.theme, s = Te(t), o = [
    t.project(s.x0, s.y0, 0),
    t.project(s.x1, s.y0, 0),
    t.project(s.x1, s.y1, 0),
    t.project(s.x0, s.y1, 0)
  ];
  b(a, o, e.ground), a.save(), zs(a, o);
  const n = a.createLinearGradient(o[0].x, o[0].y, o[2].x, o[2].y);
  n.addColorStop(0, h(e.groundLight, 0.5)), n.addColorStop(0.5, h(e.ground, 0)), n.addColorStop(1, h(e.groundDark, 0.4)), a.fillStyle = n, a.fillRect(0, 0, t.width, t.height);
  const r = Vs(t.dark ? "dark" : "light");
  r && (a.globalAlpha = 0.9, a.fillStyle = r, a.fillRect(0, 0, t.width, t.height), a.globalAlpha = 1);
  const c = s.x1 - s.x0, i = s.y1 - s.y0;
  for (let w = 0; w < 28; w += 1) {
    const v = s.x0 + T("drift-x", w) * c, M = s.y0 + T("drift-y", w) * i;
    if (ee(t.snapshot.map.zones, v, M, 40)) continue;
    const j = t.project(v, M, 0), S = (70 + T("drift-r", w) * 150) * t.scale;
    wt(
      a,
      j,
      S,
      w % 2 ? h(e.groundDark, 0.17) : h(e.groundLight, 0.21),
      0.2
    );
  }
  oo(t), no(t), eo(t), ro(t), ao(t), to(t), so(t);
  const l = t.project(s.x0, s.y0, 0), d = t.project(s.x1, s.y0, 0), p = t.project(s.x0, 260, 0), u = t.project(s.x1, 260, 0), m = Math.min(l.y, d.y), g = Math.max(p.y, u.y), y = a.createLinearGradient(0, m, 0, g);
  y.addColorStop(0, h(e.sky[2], t.dark ? 0.62 : 0.46)), y.addColorStop(0.55, h(e.dust, t.dark ? 0.1 : 0.16)), y.addColorStop(1, h(e.sky[2], 0)), b(a, [l, d, u, p], y), a.restore();
}
function zs(t, a) {
  t.beginPath(), a.forEach((e, s) => {
    s === 0 ? t.moveTo(e.x, e.y) : t.lineTo(e.x, e.y);
  }), t.closePath(), t.clip();
}
function to(t) {
  const a = t.ctx, e = t.theme, s = t.scale, o = { x: 1148, y: 640 }, n = { x: 1128, y: 96 }, r = { x: 610, y: 782 }, c = { x: 52, y: 790 };
  if (!ee(t.snapshot.map.zones, o.x, o.y, 10)) {
    const i = t.project(o.x, o.y, 0);
    Bt(a, { x: i.x + 3, y: i.y + 2 }, 12 * s, 6 * s, h(e.shadow, 0.8));
    const l = t.project(o.x, o.y, 22);
    k(a, i, l, e.metalDark, Math.max(1, 1.6 * s)), a.save(), a.translate(l.x, l.y), a.rotate(-0.5), a.beginPath(), a.ellipse(0, 0, Math.max(3, 9 * s), Math.max(1.6, 4 * s), 0, 0, f), a.fillStyle = h(e.metalLight, 0.95), a.fill(), a.strokeStyle = e.metalEdge, a.lineWidth = 0.8, a.stroke(), a.restore();
  }
  if (!ee(t.snapshot.map.zones, n.x, n.y, 10))
    for (let i = 0; i < 3; i += 1) {
      const l = n.x - i * 16, d = [
        t.project(l - 6, n.y - 5, 8),
        t.project(l + 6, n.y - 5, 8),
        t.project(l + 6, n.y + 5, 8),
        t.project(l - 6, n.y + 5, 8)
      ];
      b(a, d, t.dark ? "#1d3a4a" : "#2f5d74"), K(a, d, h("#9fd8e8", 0.55), 0.7), k(a, t.project(l, n.y + 5, 0), t.project(l, n.y + 5, 8), e.metalDark, 0.9);
    }
  if (!ee(t.snapshot.map.zones, r.x, r.y, 10)) {
    const i = [
      { x: r.x, y: r.y, w: 14, d: 12, h: 10 },
      { x: r.x + 15, y: r.y + 3, w: 11, d: 10, h: 8 }
    ];
    for (const l of i) {
      const d = t.project(l.x + l.w / 2, l.y + l.d / 2, 0);
      Bt(a, { x: d.x + 2, y: d.y + 1 }, 9 * s, 4 * s, h(e.shadow, 0.6)), P(t, l.x, l.y, l.w, l.d, 0, l.h, {
        top: x(e.deviceTop, "#b78a52", 0.4),
        south: x(e.deviceSide, "#a97c48", 0.35),
        east: x(e.deviceFront, "#8f673c", 0.3),
        edge: e.deviceEdge
      });
    }
  }
  if (!ee(t.snapshot.map.zones, c.x, c.y, 10)) {
    const i = t.project(c.x, c.y, 0), l = t.project(c.x, c.y, 34);
    Bt(a, { x: i.x + 2, y: i.y + 1 }, 7 * s, 3.5 * s, h(e.shadow, 0.6)), k(a, i, l, e.metalDark, Math.max(1, 1.4 * s)), C(a, l, Math.max(1, 1.8 * s), e.accent), k(a, t.project(c.x - 4, c.y, 26), t.project(c.x + 4, c.y, 26), h(e.metalDark, 0.8), 0.8);
  }
}
function eo(t) {
  const a = t.ctx, e = Te(t);
  for (const s of Ks) {
    const o = e.x0 + (e.x1 - e.x0) * s.x, n = e.y0 + (e.y1 - e.y0) * s.y;
    if (ee(t.snapshot.map.zones, o, n, 30)) continue;
    const r = t.project(o, n, 0), c = s.r * 1.15 * t.scale, i = s.r * 0.58 * t.scale, l = a.createRadialGradient(r.x, r.y - i * 0.15, 0, r.x, r.y, c);
    l.addColorStop(0, h(t.theme.crater, 0.55)), l.addColorStop(0.7, h(t.theme.crater, 0.28)), l.addColorStop(1, "rgba(0,0,0,0)"), a.beginPath(), a.ellipse(r.x, r.y, c, i, 0, 0, f), a.fillStyle = l, a.fill(), a.beginPath(), a.ellipse(r.x, r.y, c * 1.02, i * 1.02, 0, Math.PI * 0.95, Math.PI * 1.92), a.strokeStyle = t.theme.craterRim, a.lineWidth = Math.max(0.8, 1.3 * t.scale), a.stroke();
    for (let d = 0; d < 5; d += 1) {
      const p = T("crat-a", d) * f, u = 0.25 + T("crat-d", d) * 0.55;
      C(
        a,
        { x: r.x + Math.cos(p) * c * u, y: r.y + Math.sin(p) * i * u },
        0.6 + T("crat-r", d) * 1.2,
        h(t.theme.groundDark, 0.4)
      );
    }
  }
}
function ao(t) {
  const a = t.ctx, e = Te(t), s = t.scale > 0.7 ? 210 : 120;
  for (let o = 0; o < s; o += 1) {
    const n = e.x0 + T("rock-x", o) * (e.x1 - e.x0), r = e.y0 + T("rock-y", o) * (e.y1 - e.y0);
    if (ee(t.snapshot.map.zones, n, r, 26)) continue;
    const c = 2.4 + T("rock-s", o) * 5.4, i = t.project(n, r, 0), l = c * t.scale;
    if (l < 1.2) {
      C(a, i, l, h(t.theme.groundDark, 0.55));
      continue;
    }
    const d = [], p = 5 + o % 2;
    for (let m = 0; m < p; m += 1) {
      const g = m / p * f + T("rock-a", o) * 0.6, y = 0.65 + T(`rock-w${o}`, m) * 0.5;
      d.push({
        x: i.x + Math.cos(g) * l * y,
        y: i.y + Math.sin(g) * l * y * 0.62 - l * 0.18
      });
    }
    Bt(
      a,
      { x: i.x + l * 0.34, y: i.y + l * 0.3 },
      l * 1.05,
      l * 0.5,
      h("#241207", t.dark ? 0.4 : 0.18)
    ), b(a, d, x(t.theme.groundDark, "#3a2417", 0.35));
    const u = d.map((m) => ({ x: m.x, y: m.y - l * 0.18 }));
    b(a, u, h(t.theme.groundLight, 0.55)), K(a, d, h(t.theme.groundEdge, 0.55), 0.6);
  }
}
function so(t) {
  const a = t.ctx, e = Te(t);
  a.save(), a.lineCap = "round";
  for (let s = 0; s < 22; s += 1) {
    const o = e.x0 + T("wind-x", s) * (e.x1 - e.x0), n = e.y0 + T("wind-y", s) * (e.y1 - e.y0), r = 60 + T("wind-l", s) * 150, c = t.reduced ? 0 : (t.time * 3e-5 + T("wind-d", s)) % 1 * 40, i = t.project(o + c, n, 0), l = t.project(o + r + c, n - r * 0.16, 0);
    a.beginPath(), a.moveTo(i.x, i.y), a.quadraticCurveTo((i.x + l.x) / 2, i.y - r * 0.08 * t.scale, l.x, l.y), a.strokeStyle = h(t.theme.dust, t.dark ? 0.12 : 0.22), a.lineWidth = 0.9, a.stroke();
  }
  a.restore();
}
function oo(t) {
  const a = t.ctx, e = Te(t), s = [
    { y: e.y0 + 20, amp: 7, seed: 0.4 },
    { y: e.y1 - 28, amp: 10, seed: 2.1 },
    { y: e.y1 - 66, amp: 7, seed: 4.3 },
    { y: e.y1 - 112, amp: 5, seed: 6.2 }
  ];
  for (const o of s)
    for (let n = 0; n < 3; n += 1) {
      a.beginPath();
      let r = !1;
      for (let c = e.x0; c <= e.x1; c += 18) {
        const i = o.y + Math.sin(c * 72e-4 + o.seed + n * 1.9) * o.amp + n * 4.5, l = t.project(c, i, 0);
        r ? a.lineTo(l.x, l.y) : (a.moveTo(l.x, l.y), r = !0);
      }
      a.strokeStyle = h(n === 1 ? t.theme.groundDark : t.theme.groundLight, t.dark ? 0.1 : 0.22), a.lineWidth = n === 1 ? 1.1 : 0.8, a.stroke();
    }
}
function no(t) {
  const a = t.ctx, e = t.theme, s = { x: 984, y: 1082 }, o = { x: 805, y: 1196 }, n = 42;
  for (const r of [-5, 5]) {
    a.beginPath();
    for (let c = 0; c <= n; c += 1) {
      const i = c / n, l = s.x + (o.x - s.x) * i + Math.sin(i * Math.PI) * 12, d = s.y + (o.y - s.y) * i + r, p = t.project(l, d, 0);
      c === 0 ? a.moveTo(p.x, p.y) : a.lineTo(p.x, p.y);
    }
    a.strokeStyle = h(e.groundDark, t.dark ? 0.26 : 0.34), a.lineWidth = Math.max(0.8, 1.4 * t.scale), a.stroke();
  }
  for (let r = 2; r < n; r += 3) {
    const c = r / n, i = s.x + (o.x - s.x) * c + Math.sin(c * Math.PI) * 12, l = s.y + (o.y - s.y) * c;
    k(a, t.project(i, l - 6, 0), t.project(i, l + 6, 0), h(e.groundDark, t.dark ? 0.16 : 0.22), 0.7);
  }
}
function ro(t) {
  const a = t.ctx, e = [
    { x: 78, y: 1174, r: 20 },
    { x: 1596, y: 1170, r: 17 },
    { x: 1564, y: 74, r: 14 },
    { x: 1880, y: 640, r: 22 },
    { x: -250, y: 880, r: 18 },
    { x: 2010, y: 1320, r: 25 }
  ];
  for (const [s, o] of e.entries()) {
    if (ee(t.snapshot.map.zones, o.x, o.y, 20)) continue;
    const n = t.project(o.x, o.y, 0), r = o.r * t.scale, c = [];
    for (let i = 0; i < 7; i += 1) {
      const l = i / 7 * f + T("big-rock-a", s) * 0.7, d = 0.62 + T(`big-rock-w${s}`, i) * 0.48;
      c.push({
        x: n.x + Math.cos(l) * r * d,
        y: n.y + Math.sin(l) * r * d * 0.6 - r * 0.24
      });
    }
    Bt(
      a,
      { x: n.x + r * 0.4, y: n.y + r * 0.32 },
      r * 1.2,
      r * 0.55,
      h("#241207", t.dark ? 0.45 : 0.2)
    ), b(a, c, x(t.theme.groundDark, "#3a2417", 0.34)), b(a, c.map((i) => ({ x: i.x + r * 0.08, y: i.y - r * 0.12 })), h(t.theme.groundLight, 0.48)), K(a, c, h(t.theme.groundEdge, 0.6), 0.7);
  }
}
function Ua(t) {
  return t.kind === "greenhouse" ? 72 : t.kind === "cold" ? 56 : t.kind === "dock" ? 50 : 48;
}
const ja = 10;
function co(t) {
  const a = Ua(t), e = Math.max(2, Math.round(t.w / 118)), s = Math.max(2, Math.round(t.h / 118)), o = [], n = t.w / e;
  for (let c = 0; c < e; c += 1)
    o.push({
      zone: t,
      side: "north",
      index: c,
      count: e,
      x: t.x + c * n,
      y: t.y,
      w: n,
      d: ja,
      h: a,
      depth: t.x + c * n + n / 2 + t.y
    });
  const r = t.h / s;
  for (let c = 0; c < s; c += 1)
    o.push({
      zone: t,
      side: "west",
      index: c,
      count: s,
      x: t.x,
      y: t.y + c * r,
      w: ja,
      d: r,
      h: a,
      depth: t.x + t.y + c * r + r / 2 + 2
    });
  return o;
}
function io(t, a) {
  const e = t.ctx, { x: s, y: o, w: n, d: r } = a, c = t.dark ? 0.34 : 0.15, i = 20;
  if (a.side === "north") {
    const l = t.project(s, o + r, 1.2), d = t.project(s + n, o + r, 1.2), p = t.project(s + n, o + r + i, 0.6), u = t.project(s, o + r + i, 0.6), m = e.createLinearGradient(l.x, l.y, u.x, u.y);
    m.addColorStop(0, h("#2c1a0d", c)), m.addColorStop(1, "rgba(0,0,0,0)"), b(e, [l, d, p, u], m);
  } else {
    const l = s + n, d = t.project(l, o, 1.2), p = t.project(l, o + r, 1.2), u = t.project(l + i, o + r, 0.6), m = t.project(l + i, o, 0.6), g = e.createLinearGradient(d.x, d.y, u.x, u.y);
    g.addColorStop(0, h("#2c1a0d", c)), g.addColorStop(1, "rgba(0,0,0,0)"), b(e, [d, p, u, m], g);
  }
}
function lo(t, a) {
  const e = t.theme, s = Re[a.kind];
  if (a.kind === "greenhouse")
    return {
      top: h(e.glassLight, 0.9),
      south: h(e.glass, 0.85),
      east: h(e.glass, 0.62),
      edge: e.glassEdge,
      highlight: h("#ffffff", t.dark ? 0.18 : 0.55)
    };
  const o = a.kind === "warehouse" || a.kind === "maintenance", n = o ? x(e.wall, "#b49a76", t.dark ? 0.16 : 0.28) : e.wall, r = o ? x(e.wallLight, "#d8c4a4", t.dark ? 0.14 : 0.24) : e.wallLight, c = o ? x(e.wallDark, "#8d7150", t.dark ? 0.14 : 0.22) : e.wallDark;
  return {
    top: x(r, s, 0.22),
    south: x(n, s, 0.18),
    east: x(c, s, 0.14),
    edge: e.wallEdge,
    highlight: h("#fffaf0", t.dark ? 0.1 : 0.34)
  };
}
function ho(t, a) {
  const e = t.ctx, s = a.zone, o = t.theme, n = Re[s.kind], r = lo(t, s), { x: c, y: i, w: l, d, h: p } = a, u = t.scale > 0.52;
  io(t, a), P(t, c, i, l, d, 0, p, r);
  const m = i + d, g = c + l, y = 10, w = p * 0.1, v = p * 0.78;
  if (a.side === "north") {
    const j = t.project(c + y, m, w), S = t.project(c + l - y, m, w);
    t.project(c + l - y, m, v), t.project(c + y, m, v), b(e, [j, S, t.project(c + l - y, m, w * 0.35), t.project(c + y, m, w * 0.35)], h("#2b1b10", t.dark ? 0.45 : 0.24));
    const D = [t.project(c + y, m, p * 0.6), t.project(c + l - y, m, p * 0.6), t.project(c + l - y, m, p * 0.64), t.project(c + y, m, p * 0.64)];
    if (b(e, D, h(n, t.dark ? 0.42 : 0.5)), u) {
      if (T(s.id + a.side, a.index) > 0.24) {
        const N = c + l * 0.2, L = c + l * 0.8, A = p * 0.28, q = p * 0.72, E = [
          t.project(N, m, A),
          t.project(L, m, A),
          t.project(L, m, q),
          t.project(N, m, q)
        ];
        b(e, E, h((t.dark, o.window), t.dark ? 0.78 : 0.55)), K(e, E, h("#1d2a2e", 0.45), 0.9);
        const H = t.project((N + L) / 2, m, A), J = t.project((N + L) / 2, m, q);
        if (k(e, H, J, h("#1d2a2e", 0.35), 0.8), k(e, t.project(N, m, (A + q) / 2), t.project(L, m, (A + q) / 2), h("#1d2a2e", 0.28), 0.7), t.dark) {
          const z = t.project((N + L) / 2, m, (A + q) / 2);
          wt(e, z, Math.max(8, l * 0.5 * t.scale), h(o.windowGlow, 0.55), 0.3);
        } else
          b(e, E, h("#ffffff", 0.14));
      } else
        for (let N = 0; N < 3; N += 1) {
          const L = p * (0.3 + N * 0.09);
          k(
            e,
            t.project(c + l * 0.3, m, L),
            t.project(c + l * 0.7, m, L),
            h(o.wallEdge, 0.6),
            2.2
          );
        }
      e.strokeStyle = h(o.wallEdge, 0.5), e.lineWidth = 0.7;
      for (let N = 1; N < 3; N += 1) {
        const L = c + l / 3 * N;
        k(e, t.project(L, m, p * 0.08), t.project(L, m, p * 0.98), h(o.wallEdge, 0.42), 0.7);
      }
    }
  } else {
    const j = t.project(g, i + y, w), S = t.project(g, i + d - y, w);
    t.project(g, i + d - y, v), t.project(g, i + y, v), b(e, [j, S, t.project(g, i + d - y, w * 0.35), t.project(g, i + y, w * 0.35)], h("#2b1b10", t.dark ? 0.45 : 0.24));
    const D = [t.project(g, i + y, p * 0.6), t.project(g, i + d - y, p * 0.6), t.project(g, i + d - y, p * 0.64), t.project(g, i + y, p * 0.64)];
    if (b(e, D, h(n, t.dark ? 0.36 : 0.44)), u) {
      e.strokeStyle = h(o.wallEdge, 0.45), e.lineWidth = 0.7;
      for (let W = 1; W < 3; W += 1) {
        const N = i + d / 3 * W;
        k(e, t.project(g, N, p * 0.08), t.project(g, N, p * 0.98), h(o.wallEdge, 0.38), 0.7);
      }
    }
  }
  if (s.kind === "greenhouse") {
    for (let S = 0; S <= 3; S += 1) {
      const D = S / 3;
      if (a.side === "north") {
        const W = c + l * D;
        k(e, t.project(W, m, 0), t.project(W, m, p), h(o.glassEdge, 0.75), 1);
      } else {
        const W = i + d * D;
        k(e, t.project(g, W, 0), t.project(g, W, p), h(o.glassEdge, 0.65), 1);
      }
    }
    if (k(e, t.project(c, m, p * 0.52), t.project(c + l, m, p * 0.52), h(o.glassEdge, 0.5), 0.9), t.dark) {
      const S = t.project(c + l / 2, m, p * 0.55);
      wt(e, S, Math.max(10, l * 0.42 * t.scale), h(o.glowWarm, 0.5), 0.25);
    }
  }
  if (a.side === "north" && u && s.w > 180 && a.index === Math.floor(a.count / 2)) {
    const j = c + l * 0.34, S = c + l * 0.66, D = [
      t.project(j, m, 0.5),
      t.project(S, m, 0.5),
      t.project(S, m, p * 0.62),
      t.project(j, m, p * 0.62)
    ];
    b(e, D, h("#33241a", t.dark ? 0.72 : 0.28)), K(e, D, h(o.wallEdge, 0.8), 1), k(e, t.project((j + S) / 2, m, 0.5), t.project((j + S) / 2, m, p * 0.62), h(o.wallEdge, 0.55), 0.8);
    const W = [
      t.project(j, m, 0.8),
      t.project(S, m, 0.8),
      t.project(S, m, p * 0.08),
      t.project(j, m, p * 0.08)
    ];
    ve(e, W, h(o.hazard, 0.55), h("#241a12", 0.5), 6);
  }
  a.side === "north" ? k(e, t.project(c, m, p), t.project(c + l, m, p), h("#fff8ea", t.dark ? 0.16 : 0.5), 1.1) : k(e, t.project(g, i, p), t.project(g, i + d, p), h("#fff8ea", t.dark ? 0.12 : 0.4), 1), u && po(t, a);
}
function po(t, a) {
  const e = t.ctx, s = t.theme, o = `${a.zone.id}-${a.side}-${a.index}`, n = T(o, 1), r = (a.side === "north", a.x + a.w / 2), c = (a.side === "north", a.y + a.d / 2), i = t.project(r, c, a.h), l = t.scale;
  if (n < 0.3) {
    P(
      t,
      r - 14 / 2,
      c - 10 / 2,
      14,
      10,
      a.h,
      a.h + 8,
      { top: s.metalLight, south: s.metal, east: s.metalDark, edge: s.metalEdge }
    );
    for (let u = 0; u < 3; u += 1)
      k(
        e,
        t.project(r - 14 / 2 + 2, c + 10 / 2, a.h + 2 + u * 2),
        t.project(r + 14 / 2 - 2, c + 10 / 2, a.h + 2 + u * 2),
        h(s.metalEdge, 0.7),
        0.8
      );
  } else if (n < 0.55) {
    const d = t.project(r, c, a.h + 6);
    k(e, i, d, s.metalDark, 1), e.save(), e.translate(d.x, d.y), e.rotate(-0.44), e.beginPath(), e.ellipse(0, 0, Math.max(3, 9 * l), Math.max(1.6, 4 * l), 0, 0, f), e.fillStyle = h(s.metalLight, 0.9), e.fill(), e.strokeStyle = s.metalEdge, e.lineWidth = 0.8, e.stroke(), e.beginPath(), e.moveTo(0, 0), e.lineTo(Math.max(3, 9 * l), 0), e.stroke(), e.restore();
  } else if (n < 0.78) {
    const d = t.project(r, c, a.h + 18);
    if (k(e, i, d, s.metalDark, 1), C(e, d, Math.max(1, 1.8 * l), s.accent), !t.reduced && t.dark) {
      const p = (t.time * 8e-4 + T(o, 2)) % 1;
      e.beginPath(), e.arc(d.x, d.y, 2 + p * 8, 0, f), e.strokeStyle = h(s.accent, 0.45 * (1 - p)), e.lineWidth = 0.8, e.stroke();
    }
  } else if (n < 0.9) {
    const u = a.h + 6, m = [
      t.project(r - 20 / 2, c - 12 / 2, u),
      t.project(r + 20 / 2, c - 12 / 2, u),
      t.project(r + 20 / 2, c + 12 / 2, u),
      t.project(r - 20 / 2, c + 12 / 2, u)
    ];
    b(e, m, t.dark ? "#1d3a4a" : "#2f5d74"), e.strokeStyle = h("#9fd8e8", 0.5), e.lineWidth = 0.7;
    for (let g = 1; g < 3; g += 1) {
      const y = g / 3;
      k(e, t.project(r - 20 / 2 + 20 * y, c - 12 / 2, u), t.project(r - 20 / 2 + 20 * y, c + 12 / 2, u), h("#9fd8e8", 0.4), 0.6);
    }
    K(e, m, s.metalEdge, 0.8);
  }
}
function mo(t, a) {
  const e = t.ctx, s = t.theme, o = Re[a.kind], n = [
    t.project(a.x, a.y, 0.4),
    t.project(a.x + a.w, a.y, 0.4),
    t.project(a.x + a.w, a.y + a.h, 0.4),
    t.project(a.x, a.y + a.h, 0.4)
  ];
  b(e, n, x(s.pad, o, 0.1)), K(e, n, h(s.padEdge, 0.95), 1.5);
  const r = 7, c = [
    t.project(a.x + r, a.y + r, 0.9),
    t.project(a.x + a.w - r, a.y + r, 0.9),
    t.project(a.x + a.w - r, a.y + a.h - r, 0.9),
    t.project(a.x + r, a.y + a.h - r, 0.9)
  ], i = e.createLinearGradient(c[0].x, c[0].y, c[2].x, c[2].y);
  i.addColorStop(0, x(s.padLight, o, 0.5)), i.addColorStop(0.55, x(s.pad, o, 0.42)), i.addColorStop(1, x(s.pad, o, 0.34)), b(e, c, i), K(e, c, h(o, t.dark ? 0.45 : 0.55), 1);
  const l = [
    t.project(a.x + r + 2.5, a.y + r + 2.5, 1),
    t.project(a.x + a.w - r - 2.5, a.y + r + 2.5, 1),
    t.project(a.x + a.w - r - 2.5, a.y + a.h - r - 2.5, 1),
    t.project(a.x + r + 2.5, a.y + a.h - r - 2.5, 1)
  ];
  K(e, l, h("#ffffff", t.dark ? 0.06 : 0.22), 0.8);
  const d = h(s.padEdge, 0.8);
  for (const [p, u] of [
    [a.x + 4, a.y + 4],
    [a.x + a.w - 4, a.y + 4],
    [a.x + a.w - 4, a.y + a.h - 4],
    [a.x + 4, a.y + a.h - 4]
  ])
    C(e, t.project(p, u, 1.2), Math.max(0.7, 1.2 * t.scale), d);
  t.scale > 0.36 && uo(t, a, o), yo(t, a);
}
function uo(t, a, e) {
  const s = t.ctx, o = t.theme, n = a.x + 20, r = a.y + 20, c = a.x + a.w - 18, i = a.y + a.h - 18;
  if (a.kind === "analysis" || a.kind === "prep" || a.kind === "cold") {
    s.strokeStyle = h("#5c4a38", t.dark ? 0.14 : 0.1), s.lineWidth = 0.6;
    for (let d = n + 36; d < c; d += 36)
      k(s, t.project(d, r, 1.05), t.project(d, i, 1.05), h("#5c4a38", t.dark ? 0.14 : 0.1), 0.6);
    for (let d = r + 36; d < i; d += 36)
      k(s, t.project(n, d, 1.05), t.project(c, d, 1.05), h("#5c4a38", t.dark ? 0.14 : 0.1), 0.6);
    const l = [
      t.project(a.x + a.w / 2 - 26, r + 8, 1.1),
      t.project(a.x + a.w / 2 + 26, r + 8, 1.1),
      t.project(a.x + a.w / 2 + 26, i - 8, 1.1),
      t.project(a.x + a.w / 2 - 26, i - 8, 1.1)
    ];
    b(s, l, h("#ffffff", t.dark ? 0.03 : 0.16)), k(s, t.project(n, r + 0.5, 1.2), t.project(c, r + 0.5, 1.2), h(o.metalDark, 0.45), 1.6);
  }
  if (a.kind === "water") {
    for (const [l, d] of [
      [a.x + a.w - 52, a.y + a.h - 46],
      [a.x + a.w - 98, a.y + a.h - 46]
    ]) {
      const p = t.project(l, d, 1.15);
      for (let u = -2; u <= 2; u += 1)
        k(
          s,
          { x: p.x - 9 + u * 4, y: p.y - 4 },
          { x: p.x - 9 + u * 4, y: p.y + 4 },
          h(o.metalDark, 0.6),
          0.9
        );
      s.beginPath(), s.ellipse(p.x, p.y, 11, 5.5, 0, 0, f), s.strokeStyle = h(o.metalEdge, 0.55), s.lineWidth = 0.7, s.stroke();
    }
    for (let l = 0; l < 4; l += 1) {
      const d = t.project(a.x + 40 + T(a.id, l) * (a.w - 80), a.y + 40 + T(a.id, l + 9) * (a.h - 80), 1.1);
      s.beginPath(), s.ellipse(d.x, d.y, (6 + T(a.id, l + 3) * 16) * t.scale, (3 + T(a.id, l + 4) * 6) * t.scale, 0, 0, f), s.fillStyle = h(o.water, 0.2), s.fill(), s.strokeStyle = h(o.waterLight, 0.35), s.lineWidth = 0.6, s.stroke();
    }
  }
  if (a.kind === "cold") {
    for (let d = 0; d < 8; d += 1) {
      const p = t.project(
        a.x + 22 + T(a.id, d) * (a.w - 44),
        a.y + 20 + T(a.id, d + 5) * (a.h - 40),
        1.2
      );
      wt(s, p, (12 + T(a.id, d + 2) * 24) * t.scale, h(o.frost, 0.3), 0.2);
    }
    const l = [
      t.project(a.x + 12, a.y + 12, 1.1),
      t.project(a.x + a.w - 12, a.y + 12, 1.1),
      t.project(a.x + a.w - 12, a.y + 46, 1.1),
      t.project(a.x + 12, a.y + 46, 1.1)
    ];
    b(s, l, h(o.waterLight, 0.12));
  }
  if (a.kind === "warehouse")
    for (let l = 0; l < 2; l += 1)
      for (let d = 0; d < 3; d += 1) {
        const p = a.x + 40 + d * ((a.w - 80) / 3), u = a.y + 54 + l * ((a.h - 108) / 2), m = [
          t.project(p, u, 1.2),
          t.project(p + 66, u, 1.2),
          t.project(p + 66, u + 44, 1.2),
          t.project(p, u + 44, 1.2)
        ];
        b(s, m, h(e, t.dark ? 0.08 : 0.1)), K(s, m, h(e, t.dark ? 0.45 : 0.5), 1), k(s, m[0], m[2], h(e, 0.18), 0.7);
      }
  if (a.kind === "dock") {
    const l = [
      t.project(a.x + 18, a.y + 18, 1.05),
      t.project(a.x + a.w - 18, a.y + 18, 1.05),
      t.project(a.x + a.w - 18, a.y + a.h - 18, 1.05),
      t.project(a.x + 18, a.y + a.h - 18, 1.05)
    ];
    b(s, l, h(e, t.dark ? 0.12 : 0.16));
    for (let u = 0; u < 3; u += 1) {
      const m = a.y + a.h * (0.72 + u * 0.09), g = t.project(a.x + 26, m, 1.3), y = t.project(a.x + 96, m, 1.3);
      k(s, g, y, h(o.hazard, t.dark ? 0.55 : 0.7), Math.max(1, 2.4 * t.scale));
      const w = Math.max(3, 7 * t.scale);
      s.beginPath(), s.moveTo(y.x, y.y), s.lineTo(y.x - w * 0.8, y.y - w * 0.42), s.lineTo(y.x - w * 0.8, y.y + w * 0.42), s.closePath(), s.fillStyle = h(o.hazard, t.dark ? 0.55 : 0.7), s.fill();
    }
    const d = t.snapshot.map.chargers.filter((u) => u.x > 0 && u.y > 0), p = d.length ? d.map((u) => ({ x: u.x, y: u.y, id: u.id })) : [
      { x: a.x + a.w * 0.32, y: a.y + a.h * 0.58, id: "ch-1" },
      { x: a.x + a.w * 0.5, y: a.y + a.h * 0.58, id: "ch-2" },
      { x: a.x + a.w * 0.68, y: a.y + a.h * 0.58, id: "ch-3" }
    ];
    for (const u of p) {
      const m = t.project(u.x + 15, u.y + 12, 1.2);
      s.beginPath(), s.ellipse(m.x, m.y, 22 * t.scale, 12 * t.scale, 0, 0, f), s.fillStyle = h(o.metalDark, 0.16), s.fill(), s.strokeStyle = h("#ffffff", t.dark ? 0.25 : 0.55), s.lineWidth = 1.4, s.stroke(), s.beginPath(), s.ellipse(m.x, m.y, 18 * t.scale, 9.5 * t.scale, 0, 0, f), s.strokeStyle = h(e, 0.65), s.lineWidth = 0.9, s.stroke();
      const g = Math.max(3, 6 * t.scale);
      s.beginPath(), s.moveTo(m.x + g * 0.2, m.y - g), s.lineTo(m.x - g * 0.4, m.y + g * 0.1), s.lineTo(m.x + g * 0.05, m.y + g * 0.1), s.lineTo(m.x - g * 0.2, m.y + g), s.lineTo(m.x + g * 0.5, m.y - g * 0.2), s.lineTo(m.x + g * 0.05, m.y - g * 0.2), s.closePath(), s.fillStyle = h(e, 0.95), s.fill();
    }
  }
  if (a.kind === "maintenance") {
    for (let d = 0; d < 4; d += 1) {
      const p = t.project(
        a.x + 30 + T(a.id, d) * (a.w - 60),
        a.y + 30 + T(a.id, d + 7) * (a.h - 60),
        1.15
      );
      s.beginPath(), s.ellipse(p.x, p.y, (8 + T(a.id, d + 2) * 16) * t.scale, (4 + T(a.id, d + 3) * 7) * t.scale, 0, 0, f), s.fillStyle = h("#231812", t.dark ? 0.3 : 0.14), s.fill();
    }
    const l = [
      t.project(a.x + 26, a.y + 26, 1.15),
      t.project(a.x + a.w - 26, a.y + 26, 1.15),
      t.project(a.x + a.w - 26, a.y + a.h - 26, 1.15),
      t.project(a.x + 26, a.y + a.h - 26, 1.15)
    ];
    K(s, l, h(o.hazard, t.dark ? 0.3 : 0.4), 1);
  }
  if (a.kind === "greenhouse") {
    const l = [
      t.project(a.x + 26, a.y + a.h * 0.52, 1.15),
      t.project(a.x + a.w - 26, a.y + a.h * 0.52, 1.15),
      t.project(a.x + a.w - 26, a.y + a.h * 0.58, 1.15),
      t.project(a.x + 26, a.y + a.h * 0.58, 1.15)
    ];
    b(s, l, h(o.padLight, 0.6)), k(s, t.project(a.x + 20, a.y + 30, 1.4), t.project(a.x + 20, a.y + a.h - 26, 1.4), h(o.water, 0.55), 1.4);
  }
}
function yo(t, a) {
  const e = a.door;
  if (!e) return;
  const s = t.ctx, o = t.theme, n = [
    t.project(e.x - 16, e.y - 4, 1.3),
    t.project(e.x + 16, e.y - 4, 1.3),
    t.project(e.x + 16, e.y + 4, 1.3),
    t.project(e.x - 16, e.y + 4, 1.3)
  ];
  ve(s, n, h(o.hazard, 0.65), h("#241a12", 0.55), 5), K(s, n, h(o.padEdge, 0.7), 0.7);
}
function go(t) {
  const a = t.ctx, e = t.theme;
  for (const s of t.snapshot.map.corridors)
    s.points.length < 2 || xo(t, s);
  for (const s of t.snapshot.map.zones) {
    if (!s.door) continue;
    const o = ko(t.snapshot.map.corridors, s.door);
    if (!o) continue;
    const n = t.project(s.door.x, s.door.y, 1), r = t.project(o.x, o.y, 1);
    k(a, n, r, h(e.corridorEdge, 0.35), 3), k(a, n, r, h(e.corridor, 0.55), 2);
  }
}
function xo(t, a) {
  const e = t.ctx, s = t.theme, o = Math.max(4, a.width * t.scale), n = a.points.map((r) => t.project(r.x, r.y, 0.8));
  if (!(n.length < 2)) {
    if (e.lineCap = "round", e.lineJoin = "round", e.beginPath(), n.forEach((r, c) => c === 0 ? e.moveTo(r.x, r.y) : e.lineTo(r.x, r.y)), e.strokeStyle = s.corridorEdge, e.lineWidth = o + 3, e.stroke(), e.strokeStyle = s.corridor, e.lineWidth = o, e.stroke(), t.scale > 0.32)
      for (let r = 0; r < a.points.length - 1; r += 1) {
        const c = a.points[r], i = a.points[r + 1], l = Math.hypot(i.x - c.x, i.y - c.y) || 1, d = -(i.y - c.y) / l, p = (i.x - c.x) / l, u = a.width * 0.44, m = t.project(c.x - d * u, c.y - p * u, 1.1), g = t.project(i.x - d * u, i.y - p * u, 1.1), y = t.project(c.x + d * u, c.y + p * u, 1.1), w = t.project(i.x + d * u, i.y + p * u, 1.1);
        k(e, m, g, h(s.corridorRib, 0.8), 1), k(e, y, w, h(s.corridorEdge, 0.7), 1);
      }
    if (t.scale > 0.4) {
      for (let c = 0; c < a.points.length - 1; c += 1) {
        const i = a.points[c], l = a.points[c + 1], d = Math.hypot(l.x - i.x, l.y - i.y), p = -(l.y - i.y) / (d || 1), u = (l.x - i.x) / (d || 1);
        for (let m = 12; m < d; m += 30) {
          const g = m / d, y = i.x + (l.x - i.x) * g, w = i.y + (l.y - i.y) * g, v = a.width * 0.42, M = t.project(y - p * v, w - u * v, 1.3), j = t.project(y + p * v, w + u * v, 1.3);
          k(e, M, j, h(s.corridorRib, 0.55), 1);
        }
      }
      e.beginPath(), n.forEach((c, i) => i === 0 ? e.moveTo(c.x, c.y) : e.lineTo(c.x, c.y)), e.setLineDash([4, 9]), e.lineDashOffset = t.reduced ? 0 : -t.time * 4e-3, e.strokeStyle = h(s.route, 0.28), e.lineWidth = 1, e.stroke(), e.setLineDash([]);
    }
  }
}
function ko(t, a) {
  let e = null, s = 1 / 0;
  for (const o of t)
    for (const n of o.points) {
      const r = Math.hypot(n.x - a.x, n.y - a.y);
      r < s && (s = r, e = n);
    }
  return s < 200 ? e : null;
}
function wo(t) {
  const a = t.ctx, e = t.theme, s = t.snapshot.map.utilities;
  if (!s.length) {
    for (let o = 1; o < t.snapshot.map.zones.length; o += 1) {
      const n = t.snapshot.map.zones[o - 1], r = t.snapshot.map.zones[o], c = t.project(n.x + n.w / 2, n.y + n.h / 2, 2), i = t.project(r.x + r.w / 2, r.y + r.h / 2, 2);
      k(a, c, i, h(e.metalDark, 0.25), 1, [2, 6]);
    }
    return;
  }
  for (const o of s) Mo(t, o);
}
function Mo(t, a) {
  const e = t.ctx, s = t.theme, o = a.kind === "water" ? s.water : s.warning, n = a.points.map((r) => ({ x: r.x, y: r.y, z: 2 }));
  for (let r = 0; r < n.length - 1; r += 1) {
    const c = n[r], i = n[r + 1];
    k(e, t.project(c.x, c.y, c.z), t.project(i.x, i.y, i.z), h(o, 0.16), 8), k(e, t.project(c.x, c.y, c.z), t.project(i.x, i.y, i.z), h(s.metalDark, 0.5), 4.2), k(e, t.project(c.x, c.y, c.z), t.project(i.x, i.y, i.z), h(o, 0.9), 2.2);
  }
  if (!t.reduced && n.length > 1) {
    const r = a.points, c = r.reduce((l, d, p) => p === 0 ? 0 : l + Math.hypot(d.x - r[p - 1].x, d.y - r[p - 1].y), 0), i = 3;
    for (let l = 0; l < i; l += 1) {
      const d = (t.time * 6e-5 + l / i) % 1 * c, p = jo(r, d);
      if (!p) continue;
      const u = t.project(p.x, p.y, 2);
      C(e, u, Math.max(1, 1.8 * t.scale), h("#ffffff", 0.85)), e.beginPath(), e.arc(u.x, u.y, Math.max(2, 4.5 * t.scale), 0, f), e.fillStyle = h(o, 0.18), e.fill();
    }
  }
  if (t.scale > 0.85) {
    const r = a.points[Math.floor(a.points.length / 2)];
    if (r) {
      const c = t.project(r.x, r.y, 8);
      e.font = '600 8px Inter, "PingFang SC", system-ui, sans-serif';
      const i = e.measureText(a.label).width + 10;
      ht(e, c.x - i / 2, c.y - 6, i, 12, 4, s.labelBg), jt(e, a.label, c.x, c.y, 8, s.muted, 600);
    }
  }
}
function jo(t, a) {
  let e = a;
  for (let s = 1; s < t.length; s += 1) {
    const o = t[s - 1], n = t[s], r = Math.hypot(n.x - o.x, n.y - o.y);
    if (e <= r) {
      const c = r === 0 ? 0 : e / r;
      return { x: o.x + (n.x - o.x) * c, y: o.y + (n.y - o.y) * c };
    }
    e -= r;
  }
  return t[t.length - 1] ?? null;
}
function ue(t) {
  return {
    x: t.x,
    y: t.y,
    w: t.w ?? 44,
    d: t.d ?? 40,
    h: t.h ?? 28
  };
}
function $e(t) {
  return ["running", "moving", "working", "busy"].includes(t.status);
}
function ge(t, a = 0) {
  return T(t.id, a) * f;
}
function Fe(t, a) {
  const e = t.theme, s = { top: e.deviceTop, south: e.deviceSide, east: e.deviceFront };
  return a && (s.top = x(e.deviceTop, a, 0.4), s.south = x(e.deviceSide, a, 0.32), s.east = x(e.deviceFront, a, 0.24)), {
    ...s,
    edge: e.deviceEdge,
    highlight: h("#fffaf0", t.dark ? 0.12 : 0.4),
    accent: e.accent
  };
}
function X(t, a, e, s, o, n) {
  return [t.project(a, s, o), t.project(e, s, o), t.project(e, s, n), t.project(a, s, n)];
}
function vo(t, a, e, s, o, n) {
  return [t.project(a, e, o), t.project(a, s, o), t.project(a, s, n), t.project(a, e, n)];
}
function ca(t, a, e, s, o = "vertical") {
  const n = t.ctx, r = a.map((u) => u.x), c = a.map((u) => u.y), i = Math.min(...r), l = Math.max(...r), d = Math.min(...c), p = Math.max(...c);
  n.strokeStyle = e, n.lineWidth = 0.7;
  for (let u = 1; u < s; u += 1) {
    const m = u / s;
    if (o === "vertical") {
      const g = i + (l - i) * m;
      n.beginPath(), n.moveTo(g, d + (p - d) * 0.06), n.lineTo(g, p - (p - d) * 0.08), n.stroke();
    } else {
      const g = d + (p - d) * m;
      n.beginPath(), n.moveTo(i + (l - i) * 0.06, g), n.lineTo(l - (l - i) * 0.06, g), n.stroke();
    }
  }
}
function Ut(t, a, e = {}) {
  const s = t.ctx, o = a.map((m) => m.x), n = a.map((m) => m.y), r = Math.min(...o), c = Math.min(...n), i = Math.max(...o) - r, l = Math.max(...n) - c;
  if (i < 3 || l < 3) return;
  const d = e.color ?? t.theme.screenGlow, p = e.intensity ?? 1, u = e.phase ?? 0;
  if (s.save(), s.beginPath(), a.forEach((m, g) => g === 0 ? s.moveTo(m.x, m.y) : s.lineTo(m.x, m.y)), s.closePath(), s.clip(), s.fillStyle = t.theme.screen, s.fillRect(r, c, i, l), e.variant === "bars") {
    const m = Math.max(3, Math.floor(i / 4));
    for (let g = 0; g < m; g += 1) {
      const y = t.reduced ? 0.55 : 0.28 + Math.abs(Math.sin(t.time * 16e-4 + u + g * 0.8)) * 0.62, w = Math.max(1, i / m * 0.56), v = l * 0.7 * y * p;
      s.fillStyle = h(d, 0.35 + y * 0.5), s.fillRect(r + (g + 0.22) * (i / m), c + l * 0.82 - v, w, v);
    }
  } else if (e.variant === "grid") {
    s.strokeStyle = h(d, 0.28), s.lineWidth = 0.6;
    for (let g = 1; g < 4; g += 1) {
      const y = c + l / 4 * g;
      s.beginPath(), s.moveTo(r + i * 0.08, y), s.lineTo(r + i * 0.92, y), s.stroke();
    }
    const m = t.reduced ? 0.5 : (t.time * 22e-5 + u) % 1;
    s.fillStyle = h(d, 0.3), s.fillRect(r + i * 0.08 + m * i * 0.84, c + l * 0.12, Math.max(1, i * 0.03), l * 0.76);
  } else {
    s.beginPath();
    const m = Math.max(6, Math.floor(i / 2));
    for (let g = 0; g <= m; g += 1) {
      const y = g / m, w = Math.sin(y * 7 + u + (t.reduced ? 0 : t.time * 2e-3)) * 0.28 + Math.sin(y * 17 + u * 1.7) * 0.12, v = r + y * i, M = c + l * 0.52 + w * l * 0.62 * p;
      g === 0 ? s.moveTo(v, M) : s.lineTo(v, M);
    }
    s.strokeStyle = d, s.lineWidth = 1, s.stroke();
  }
  s.globalAlpha = t.dark ? 0.08 : 0.12;
  for (let m = c; m < c + l; m += 3)
    s.fillStyle = d, s.fillRect(r, m, i, 0.7);
  s.globalAlpha = 1, s.restore(), K(s, a, h("#fff8ee", t.dark ? 0.16 : 0.3), 0.7);
}
function ye(t, a, e, s, o) {
  const n = t.ctx, r = Math.max(2.4, e);
  n.beginPath(), n.arc(a.x, a.y, r, 0, f), n.fillStyle = t.dark ? "rgba(20, 16, 12, 0.75)" : "rgba(255, 252, 245, 0.9)", n.fill(), n.strokeStyle = o, n.lineWidth = 0.9, n.stroke();
  const c = -Math.PI * 0.75 + _(s, 0, 1) * Math.PI * 1.5;
  n.beginPath(), n.moveTo(a.x, a.y), n.lineTo(a.x + Math.cos(c) * r * 0.78, a.y + Math.sin(c) * r * 0.78), n.strokeStyle = o, n.lineWidth = 1, n.stroke(), C(n, a, Math.max(0.6, r * 0.14), o);
}
function va(t, a, e, s, o = {}) {
  const n = t.ctx;
  if (a.length < 2) return;
  const r = a.map((c) => t.project(c.x, c.y, c.z));
  n.lineCap = "round", n.lineJoin = "round", n.beginPath(), r.forEach((c, i) => i === 0 ? n.moveTo(c.x, c.y) : n.lineTo(c.x, c.y)), n.strokeStyle = s, n.lineWidth = Math.max(1, e * t.scale), n.stroke();
  for (const c of r)
    n.beginPath(), n.arc(c.x, c.y, Math.max(1, e * t.scale * 0.62), 0, f), n.fillStyle = x(s, "#000000", 0.2), n.fill();
  if (o.flow && !t.reduced) {
    const c = o.flowColor ?? h("#ffffff", 0.55);
    n.setLineDash([2, 10]), n.lineDashOffset = -t.time * 0.035, n.strokeStyle = c, n.lineWidth = Math.max(0.8, e * t.scale * 0.4), n.stroke(), n.setLineDash([]);
  }
}
function Va(t, a, e, s) {
  const o = t.ctx;
  o.beginPath(), o.moveTo(a.x, a.y), o.bezierCurveTo(a.x, a.y + 8, e.x, e.y - 10, e.x, e.y), o.strokeStyle = s, o.lineWidth = 1, o.stroke();
}
function ea(t, a, e, s, o, n = 0.4) {
  const r = t.ctx, c = r.createLinearGradient(a.x, a.y, (e.x + s.x) / 2, (e.y + s.y) / 2);
  c.addColorStop(0, h(o, Math.min(1, n))), c.addColorStop(0.55, h(o, n * 0.28)), c.addColorStop(1, "rgba(255,255,255,0)"), b(r, [a, e, s], c);
}
function Pt(t, a, e, s = 0, o = 1) {
  const n = t.ctx, r = t.reduced ? 0.85 : 0.55 + Math.sin(t.time * 4e-3 + s) * 0.35, c = Math.max(1.1, o * 1.8 * t.scale);
  n.beginPath(), n.arc(a.x, a.y, c * 2.6, 0, f), n.fillStyle = h(e, 0.18 * r), n.fill(), C(n, a, c, h(e, 0.6 + r * 0.4));
}
function Ka(t, a, e, s = {}) {
  const o = t.ctx, n = s.size ?? 9;
  o.font = `600 ${n}px Inter, "PingFang SC", system-ui, sans-serif`;
  const r = o.measureText(a).width + 10, c = n + 6, i = e.x - r / 2, l = s.below ? e.y + 4 : e.y - c - 4;
  ht(o, i, l, r, c, 4, t.theme.labelBg), Tt(o, i, l, r, c, 4), o.strokeStyle = s.tone ? h(s.tone, 0.55) : t.theme.labelEdge, o.lineWidth = 0.8, o.stroke(), jt(o, a, e.x, l + c / 2 + 0.5, n, s.tone ?? t.theme.label, 650);
}
function Be(t, a, e, s, o, n = "rgba(240, 248, 250, 0.55)") {
  const r = Math.max(1.6, s * 0.42);
  ht(t, a - r / 2, e - s, r, s, Math.max(0.8, r * 0.3), n), ht(t, a - r / 2, e - s * 0.62, r, s * 0.62, Math.max(0.6, r * 0.28), o);
  const c = Math.max(1, r * 0.7);
  ht(t, a - c / 2, e - s - c * 0.7, c, c * 0.7, 0.6, h("#ffffff", 0.5));
}
function Ye(t, a, e, s, o, n = 0.35) {
  const r = t.project(a, e, 0), c = t.ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, s * t.scale);
  c.addColorStop(0, h(o, n)), c.addColorStop(1, "rgba(255,255,255,0)"), t.ctx.beginPath(), t.ctx.ellipse(r.x, r.y, Math.max(1, s * t.scale), Math.max(0.6, s * 0.52 * t.scale), 0, 0, f), t.ctx.fillStyle = c, t.ctx.fill();
}
function ae(t, a, e, s, o, n = 1) {
  const r = t.project(a + s / 2, e + o / 2, 0);
  Bt(
    t.ctx,
    { x: r.x + 2, y: r.y + 1.5 },
    Math.max(1, (s + o) * 0.36 * t.scale),
    Math.max(0.6, (s + o) * 0.2 * t.scale),
    h(t.theme.shadow, n)
  );
}
function me(t, a) {
  return Rt(t.theme, a.tone);
}
function aa(t, a, e, s = {}) {
  if (t.showReadouts) return;
  const o = t.ctx, n = a.name.length > 18 ? `${a.name.slice(0, 17)}…` : a.name, r = s.compact ? 8.5 : 9.5;
  o.font = `500 ${r}px Inter, "PingFang SC", system-ui, sans-serif`;
  const c = Math.min(190, o.measureText(n).width + 14), i = r + 6, l = e.x - c / 2, d = e.y - i;
  ht(o, l, d, c, i, 4, t.theme.labelBg), s.tone && ht(o, l, d, 2.4, i, 1.2, s.tone), jt(o, n, e.x, d + i / 2 + 0.5, r, t.theme.label, 500);
}
function Qe(t, a) {
  const e = typeof t == "number" ? t : Number(t);
  return Number.isFinite(e) ? e : a;
}
function So(t, a) {
  const { x: e, y: s, w: o, d: n, h: r } = ue(a), c = t.ctx, i = t.theme, l = Fe(t, "#8f9ba2"), d = me(t, a), p = _(Qe(a.meta?.soc, 64) / 100, 0, 1), u = Math.max(0, Qe(a.meta?.capacity, 0)), m = Math.max(0, Qe(a.meta?.demand, 0)), g = a.meta?.shed === !0, y = x(d, i.deviceSide, t.dark ? 0.5 : 0.34), w = g ? i.warning : p < 0.2 ? i.danger : p < 0.45 ? i.warning : y, v = ge(a, 5);
  ae(t, e, s, o, n, 0.95);
  const M = r * 0.12;
  P(t, e, s, o, n, 0, M, {
    top: i.metalDark,
    south: x(i.metalDark, "#1b1f21", 0.28),
    east: x(i.metalDark, "#14181a", 0.3),
    edge: i.metalEdge
  });
  for (const nt of [0.12, 0.78])
    b(
      c,
      X(t, e + o * nt, e + o * (nt + 0.1), s + n + 0.3, r * 0.03, r * 0.09),
      h(i.screen, 0.75)
    );
  for (let nt = 0; nt < 4; nt += 1)
    C(
      c,
      t.project(e + o * (0.08 + nt * 0.28), s + n + 0.4, r * 0.06),
      Math.max(0.4, 0.8 * t.scale),
      h(i.metalLight, 0.55)
    );
  const j = r * 0.1, S = r * 0.94;
  P(t, e, s, o, n, j, S, {
    top: l.top,
    south: l.south,
    east: l.east,
    edge: l.edge,
    highlight: l.highlight
  }), P(t, e + o * 0.04, s + n * 0.08, o * 0.92, n * 0.62, S, S + r * 0.05, {
    top: x(l.top, i.metalDark, 0.14),
    south: l.south,
    east: l.east,
    edge: l.edge
  });
  for (let nt = 0; nt < 3; nt += 1) {
    const Mt = s + n * (0.16 + nt * 0.16);
    k(
      c,
      t.project(e + o * 0.1, Mt, S + r * 0.052),
      t.project(e + o * 0.9, Mt, S + r * 0.052),
      h(i.metalEdge, 0.55),
      0.7
    );
  }
  P(t, e + o * 0.68, s + n * 0.18, o * 0.12, n * 0.12, S + r * 0.05, S + r * 0.1, {
    top: i.metalLight,
    south: i.metal,
    east: i.metalDark,
    edge: i.metalEdge
  });
  const D = M + r * 0.03, W = X(t, e + o * 0.04, e + o * 0.96, s + n, D, S - r * 0.04);
  b(c, W, x(i.deviceFront, "#222d31", 0.28)), K(c, W, h(i.deviceEdge, 0.8), 0.8);
  const N = 4, L = 2, A = e + o * 0.07, q = e + o * 0.66, E = D + r * 0.05, H = S - r * 0.1;
  for (let nt = 0; nt < L; nt += 1)
    for (let Mt = 0; Mt < N; Mt += 1) {
      const se = nt * N + Mt, It = A + (q - A) * (Mt / N) + o * 6e-3, At = A + (q - A) * ((Mt + 1) / N) - o * 6e-3, Dt = E + (H - E) * (nt / L) + r * 0.012, St = E + (H - E) * ((nt + 1) / L) - r * 0.012;
      b(c, X(t, It, At, s + n + 0.3, Dt, St), x(i.metalDark, "#2a3a41", 0.4)), K(c, X(t, It, At, s + n + 0.3, Dt, St), h(i.deviceEdge, 0.55), 0.6);
      const _t = _(p + (T(a.id, se) - 0.5) * 0.07, 0.02, 1), Vt = Dt + (St - Dt) * (0.14 + _t * 0.68);
      b(
        c,
        X(t, It + o * 4e-3, At - o * 4e-3, s + n + 0.4, Dt + r * 6e-3, Vt),
        h(w, 0.85)
      ), C(
        c,
        t.project((It + At) / 2, s + n + 0.5, St - (St - Dt) * 0.12),
        Math.max(0.45, 0.9 * t.scale),
        h(i.metalLight, 0.7)
      );
    }
  const J = e + o * 0.81, z = J - o * 0.1, R = J + o * 0.1, O = S - r * 0.32, Z = S - r * 0.12;
  b(c, X(t, z, R, s + n + 0.3, O, Z), h(i.screen, 0.92)), K(c, X(t, z, R, s + n + 0.3, O, Z), h(i.metalDark, 0.6), 0.6);
  const $ = O + r * 0.05, F = $ + r * 0.055;
  b(
    c,
    X(t, z + o * 0.012, R - o * 0.012, s + n + 0.4, $, F),
    h(i.metalDark, 0.8)
  ), b(
    c,
    X(
      t,
      z + o * 0.012,
      z + o * 0.012 + (R - z - o * 0.024) * p,
      s + n + 0.5,
      $,
      F
    ),
    h(w, 0.95)
  );
  const Y = u > 0 ? _(m / u, 0, 1) : 0, ct = O + r * 0.012, yt = ct + r * 0.022;
  b(
    c,
    X(t, z + o * 0.012, R - o * 0.012, s + n + 0.4, ct, yt),
    h(i.metalDark, 0.8)
  ), Y > 0.01 && b(
    c,
    X(
      t,
      z + o * 0.012,
      z + o * 0.012 + (R - z - o * 0.024) * Y,
      s + n + 0.5,
      ct,
      yt
    ),
    h(Y > 0.9 ? i.danger : d, 0.9)
  );
  const B = t.project(J, s + n + 0.4, j + (S - j) * 0.5), pt = Math.max(2.2, o * 0.065 * t.scale);
  c.beginPath(), c.arc(B.x, B.y, pt, 0, f), c.fillStyle = h(i.screen, 0.55), c.fill(), c.strokeStyle = h(i.metalEdge, 0.7), c.lineWidth = 0.8, c.stroke();
  const G = t.reduced ? 0.7 : t.time * (45e-4 + Math.min(m, 90) * 9e-5);
  for (let nt = 0; nt < 6; nt += 1) {
    const Mt = G + nt / 6 * f;
    k(
      c,
      B,
      { x: B.x + Math.cos(Mt) * pt * 0.84, y: B.y + Math.sin(Mt) * pt * 0.84 },
      h(i.metalLight, 0.8),
      Math.max(0.7, 0.9 * t.scale)
    );
  }
  C(c, B, Math.max(0.6, pt * 0.16), h(i.metalDark, 0.9)), ye(
    t,
    t.project(J, s + n + 0.4, j + (S - j) * 0.24),
    Math.max(2, 2.2 * t.scale),
    p,
    w
  ), k(
    c,
    t.project(e + o, s + n * 0.5, j),
    t.project(e + o, s + n * 0.5, S),
    h(i.metalEdge, 0.4),
    0.7
  );
  for (let nt = 0; nt < 4; nt += 1) {
    const Mt = j + (S - j) * (0.5 + nt * 0.07);
    k(
      c,
      t.project(e + o, s + n * 0.16, Mt),
      t.project(e + o, s + n * 0.44, Mt),
      h(i.metalEdge, 0.5),
      0.7
    );
  }
  const tt = vo(t, e + o, s + n * 0.58, s + n * 0.8, S - r * 0.12, S - r * 0.05);
  b(c, tt, h(i.hazard, 0.35)), K(c, tt, h(i.metalEdge, 0.5), 0.6);
  const ot = g && !t.reduced ? 0.5 + Math.sin(t.time * 8e-3 + v) * 0.35 : 1;
  b(
    c,
    X(t, e + o * 0.04, e + o * 0.96, s + n + 0.35, D + r * 5e-3, D + r * 0.05),
    h(g ? i.warning : i.hazard, 0.62 * ot)
  ), g && b(
    c,
    X(t, e + o * 0.04, e + o * 0.96, s + n + 0.35, S - r * 0.035, S - r * 4e-3),
    h(i.warning, 0.5 + (t.reduced ? 0.2 : Math.sin(t.time * 8e-3 + v) * 0.3))
  ), Pt(t, t.project(e + o * 0.9, s + n + 0.4, j + r * 0.06), g ? i.warning : d, v, 0.8), Va(
    t,
    t.project(e + o, s + n * 0.86, j + r * 0.06),
    t.project(e + o + 10, s + n * 0.92, 1),
    h(i.metalDark, 0.65)
  );
}
function Sa(t, a) {
  const e = typeof t == "number" ? t : Number(t);
  return Number.isFinite(e) ? e : a;
}
function To(t, a) {
  const { x: e, y: s, w: o, d: n, h: r } = ue(a), c = t.ctx, i = t.theme, l = e + o / 2, d = s + n / 2, p = Math.min(o, n) * 0.42, u = me(t, a), m = _(Sa(a.meta?.units, 56) / 100, 0, 1), g = Sa(a.meta?.pressure, Number.NaN), y = Number.isFinite(g) ? _(g / 320, 0, 1) : m, w = y > 0.86 ? i.danger : y > 0.72 ? i.warning : u, v = ge(a, 4), M = t.scale > 0.62;
  ae(t, e, s, o, n, 0.9), Me(t, e + o * 0.08, s + n * 0.08, o * 0.84, n * 0.84, r * 0.012, x(i.pad, i.ground, 0.55), h(i.padEdge, 0.5)), bt(t, l, d, p * 1.12, 0, r * 0.09, {
    side: x(i.metal, i.metalDark, 0.35),
    sideDark: i.metalDark,
    top: i.metal,
    edge: i.metalEdge
  });
  const j = r * 0.08, S = r * 0.79, D = bt(t, l, d, p, j, S, {
    side: x(i.metalLight, "#b9c9cf", 0.32),
    sideDark: x(i.metal, "#8ea2a9", 0.36),
    top: x(i.metalLight, "#d3e0e4", 0.4),
    edge: i.metalEdge
  });
  for (const $ of [0.2, 0.45, 0.7]) {
    const F = t.project(l, d, j + (S - j) * $);
    c.beginPath(), c.ellipse(F.x, F.y, D.rx, D.ry, 0, 0, Math.PI, !1), c.strokeStyle = h(i.metalDark, 0.6), c.lineWidth = Math.max(0.7, 1.1 * t.scale), c.stroke();
  }
  Is(t, l, d, p * 0.99, S, r * 0.11, x(i.metalLight, "#cfdde2", 0.45), i.metalEdge), bt(t, l, d, p * 0.15, S + r * 0.1, S + r * 0.16, {
    side: i.metalLight,
    sideDark: i.metal,
    top: i.metalLight,
    edge: i.metalEdge
  });
  const W = t.project(l, d, S + r * 0.175);
  c.beginPath(), c.ellipse(W.x, W.y, Math.max(2.2, p * 0.34 * t.scale), Math.max(1.1, p * 0.16 * t.scale), 0, 0, f), c.strokeStyle = h(u, 0.9), c.lineWidth = 1.1, c.stroke();
  for (let $ = 0; $ < 4; $ += 1) {
    const F = $ / 4 * f + 0.4;
    k(
      c,
      W,
      {
        x: W.x + Math.cos(F) * p * 0.34 * t.scale,
        y: W.y + Math.sin(F) * p * 0.16 * t.scale
      },
      h(u, 0.75),
      0.7
    );
  }
  if (M) {
    const $ = l - p * 0.86, F = d + p * 0.05, Y = d + p * 0.42, ct = r * 0.04, yt = S - r * 0.02;
    for (const B of [F, Y])
      k(
        c,
        t.project($, B, ct),
        t.project($, B, yt),
        i.metalDark,
        Math.max(0.8, 1 * t.scale)
      );
    for (let B = 1; B < 9; B += 1) {
      const pt = ct + (yt - ct) * B / 9;
      k(c, t.project($, F, pt), t.project($, Y, pt), i.metalDark, 0.7);
    }
  }
  const N = l + p * 0.55, L = d + p * 0.86, A = t.project(N, L, j + r * 0.02), q = t.project(N, L, S - r * 0.03);
  k(c, A, q, h(i.metalDark, 0.7), Math.max(1.8, 2.6 * t.scale));
  const E = t.project(N, L, j + r * 0.02 + (S - j - r * 0.05) * m);
  if (k(
    c,
    A,
    E,
    h(x(i.water, i.metalLight, 0.45), 0.95),
    Math.max(1.1, 1.8 * t.scale)
  ), ye(
    t,
    t.project(l - p * 0.12, d + p * 0.92, j + (S - j) * 0.58),
    Math.max(2.4, 2.9 * t.scale),
    y,
    w
  ), t.scale > 0.9) {
    const $ = t.project(l + p * 0.28, d + p * 0.98, r * 0.045), F = Math.min(28, Math.max(15, 19 * t.scale)), Y = Math.min(10, Math.max(6.5, 8 * t.scale));
    je(c, $.x - F / 2, $.y - Y / 2, F, Y, i.labelBg, i.labelEdge), jt(c, "CO₂", $.x, $.y + 0.5, Math.max(4.4, Math.min(6.4, 5 * t.scale)), i.label, 700);
  }
  const H = j + (S - j) * 0.1, J = j + (S - j) * 0.26, z = t.reduced ? 0.48 : 0.4 + Math.sin(t.time * 17e-4 + v) * 0.1, R = x(i.metalLight, "#d9f0fa", t.dark ? 0.42 : 0.55), O = t.project(l, d, J), Z = t.project(l, d, H);
  if (c.save(), c.globalAlpha = z, c.beginPath(), c.moveTo(O.x - D.rx, O.y), c.lineTo(Z.x - D.rx, Z.y), c.ellipse(Z.x, Z.y, D.rx, D.ry, 0, Math.PI, 0, !0), c.lineTo(O.x + D.rx, O.y), c.ellipse(O.x, O.y, D.rx, D.ry, 0, 0, Math.PI, !1), c.closePath(), c.fillStyle = R, c.fill(), c.restore(), c.beginPath(), c.ellipse(O.x, O.y, D.rx, D.ry, 0, 0, Math.PI, !1), c.strokeStyle = h("#ffffff", 0.2), c.lineWidth = 0.8, c.stroke(), M)
    for (let $ = 0; $ < 6; $ += 1) {
      const F = 0.2 + T(a.id, $) * 2.6, Y = H + (J - H) * T(a.id, $ + 7);
      C(
        c,
        t.project(l + Math.cos(F) * p * 0.98, d + Math.sin(F) * p * 0.98, Y),
        Math.max(0.45, 0.9 * t.scale),
        h("#eafaff", 0.42)
      );
    }
  if (va(
    t,
    [
      { x: l + p, y: d, z: j + (S - j) * 0.62 },
      { x: e + o + 4, y: d, z: j + (S - j) * 0.62 },
      { x: e + o + 4, y: d, z: r * 0.05 }
    ],
    1.25,
    h(i.metalDark, 0.8),
    { flow: !0, flowColor: h("#ffffff", 0.22) }
  ), va(
    t,
    [
      { x: l + p, y: d, z: j + r * 0.05 },
      { x: l + p * 1.2, y: d + p * 0.2, z: j + r * 0.05 },
      { x: e + o + 3, y: d + p * 0.2, z: r * 0.03 }
    ],
    1.1,
    h(i.waterDark, 0.7)
  ), Pt(t, t.project(l, d, S + r * 0.19), w, v, 0.6), Pt(t, t.project(l + p * 0.55, d + p * 0.86, j + (S - j) * 0.84), w, ge(a, 8), 0.5), !t.reduced && y > 0.8)
    for (let $ = 0; $ < 3; $ += 1) {
      const F = (t.time * 25e-5 + $ / 3) % 1, Y = t.project(l + p * 0.35, d, S + r * 0.2 + F * r * 0.1);
      c.beginPath(), c.ellipse(Y.x, Y.y, (2 + F * 5) * t.scale, (1.2 + F * 2.6) * t.scale, 0, 0, f), c.fillStyle = h("#ffffff", 0.16 * (1 - F)), c.fill();
    }
}
function bo(t, a) {
  const e = t.ctx, s = t.theme, o = ue(a), n = _(o.w / 56, 0.55, 1.6), r = _(o.d / 44, 0.55, 1.6), c = _(o.h / 66, 0.55, 1.6), i = a.meta ?? {}, l = i.quarantine === !0, d = i.uv === !0 || l, p = typeof i.pressure == "number" && Number.isFinite(i.pressure) ? i.pressure : 101, u = l ? s.danger : Rt(s, "green"), m = Rt(s, "violet"), g = T(a.id, 5) * f, y = t.reduced ? 0.62 : 0.55 + Math.sin(t.time * 2e-3 + g) * 0.2, w = t.scale > 0.62;
  ae(t, o.x, o.y, o.w, o.d, 1), ve(
    e,
    [
      t.project(o.x + o.w * 0.14, o.y + o.d + 1, 0.5),
      t.project(o.x + o.w * 0.86, o.y + o.d + 1, 0.5),
      t.project(o.x + o.w * 0.86, o.y + o.d + 7 * r, 0.5),
      t.project(o.x + o.w * 0.14, o.y + o.d + 7 * r, 0.5)
    ],
    h(s.hazard, 0.5),
    h("#241a12", 0.55),
    5
  ), d && Ye(t, o.x + o.w / 2, o.y + o.d + 4 * r, o.w * 0.42, m, l ? 0.18 : 0.08);
  const v = Fe(t, "#a3b0b6");
  P(t, o.x, o.y, o.w, o.d, 0, o.h, {
    top: v.top,
    south: v.south,
    east: v.east,
    edge: v.edge,
    highlight: v.highlight
  }), b(e, X(t, o.x, o.x + o.w, o.y + o.d + 0.3, 0, 4 * c), h(s.metalDark, 0.85));
  for (let G = 1; G < 4; G += 1) {
    const tt = o.y + o.d / 4 * G;
    k(
      e,
      t.project(o.x + o.w + 0.3, tt, 3),
      t.project(o.x + o.w + 0.3, tt, o.h - 4),
      h(s.metalEdge, 0.35),
      0.7
    );
  }
  const M = o.y + o.d + 0.45, j = o.x + o.w * 0.14, S = o.x + o.w * 0.86, D = o.h * 0.15, W = o.h * 0.85, N = X(t, j, S, M, D, W), L = S - j, A = W - D;
  b(e, N, h(s.screen, t.dark ? 0.85 : 0.72)), b(
    e,
    X(t, j + L * 0.08, j + L * 0.36, M + 0.05, D + 2, D + A * 0.3),
    h(s.metalDark, 0.85)
  ), b(
    e,
    X(t, j + L * 0.12, j + L * 0.3, M + 0.05, D + A * 0.3, D + A * 0.42),
    h(s.metal, 0.65)
  ), b(
    e,
    X(t, j + L * 0.54, S - L * 0.08, M + 0.05, D + A * 0.24, D + A * 0.32),
    h(s.metal, 0.7)
  ), k(
    e,
    t.project(j + L * 0.58, M + 0.06, D + 2),
    t.project(j + L * 0.58, M + 0.06, D + A * 0.24),
    h(s.metalDark, 0.8),
    0.9
  ), k(
    e,
    t.project(S - L * 0.12, M + 0.06, D + 2),
    t.project(S - L * 0.12, M + 0.06, D + A * 0.24),
    h(s.metalDark, 0.8),
    0.9
  ), k(
    e,
    t.project(j + L * 0.06, M + 0.06, D + A * 0.5),
    t.project(S - L * 0.06, M + 0.06, D + A * 0.5),
    h(s.metalDark, 0.45),
    0.7
  );
  const q = X(
    t,
    j + L * 0.12,
    S - L * 0.12,
    M + 0.07,
    W - A * 0.16,
    W - A * 0.11
  );
  b(e, q, h(m, d ? 0.85 : 0.25)), b(e, N, h(s.glass, t.dark ? 0.28 : 0.32)), d && b(e, N, h(m, l ? 0.16 : 0.07)), K(e, N, h(s.glassEdge, 0.9), 0.9), k(
    e,
    t.project(j + L * 0.18, M + 0.6, D + A * 0.12),
    t.project(j + L * 0.32, M + 0.6, W - A * 0.15),
    h("#ffffff", t.dark ? 0.1 : 0.26),
    1.4
  ), k(
    e,
    t.project((j + S) / 2, M + 0.6, D + 2),
    t.project((j + S) / 2, M + 0.6, W - 2),
    h(s.metalDark, 0.85),
    1.1
  );
  for (const G of [-1, 1]) {
    const tt = (j + S) / 2 + G * L * 0.06;
    k(
      e,
      t.project(tt, M + 0.7, D + A * 0.44),
      t.project(tt, M + 0.7, D + A * 0.56),
      s.metalLight,
      1.4
    );
  }
  const E = _(4 * n, 2.6, 6), H = x(s.metal, s.metalDark, 0.3);
  for (const [G, tt] of [
    [j - E, j],
    [S, S + E]
  ]) {
    const ot = X(t, G, tt, M + 0.2, D, W);
    b(e, ot, H), K(e, ot, h(s.metalEdge, 0.9), 0.9);
  }
  const J = X(t, j - E, S + E, M + 0.2, W, W + E * 1.4);
  b(e, J, x(s.metal, s.metalLight, 0.25)), K(e, J, h(s.metalEdge, 0.9), 0.9);
  const z = X(t, j - E, S + E, M + 0.2, D - E * 1.1, D);
  b(e, z, x(s.metalDark, s.metal, 0.35)), ve(
    e,
    X(t, j - E, S + E, M + 0.3, D - E * 0.95, D - E * 0.15),
    h(s.hazard, 0.92),
    h("#241a12", 0.6),
    5
  );
  const R = L * 0.36, O = X(
    t,
    (j + S) / 2 - R / 2,
    (j + S) / 2 + R / 2,
    M + 0.35,
    W + E * 0.22,
    W + E * 1.16
  );
  if (b(e, O, h(s.labelBg, 0.92)), K(e, O, h(u, 0.55), 0.8), w) {
    const G = t.project((j + S) / 2, M + 0.4, W + E * 0.69);
    jt(e, "隔离舱", G.x, G.y, _(5.2 * Math.min(n, c) * t.scale, 4, 8), s.label, 650);
  }
  const Z = t.project(o.x + o.w * 0.93, M + 0.5, o.h * 0.58);
  if (ye(
    t,
    Z,
    Math.max(2, 3.2 * Math.min(n, c) * t.scale),
    _((p - 40) / 120, 0, 1),
    l ? u : m
  ), w && t.scale > 1.2) {
    const G = t.project(o.x + o.w * 0.93, M + 0.6, o.h * 0.5);
    jt(e, `${p.toFixed(0)}`, G.x, G.y, 4.5, s.muted, 600);
  }
  const $ = o.h + 9 * c;
  P(t, o.x + o.w * 0.24, o.y + o.d * 0.18, o.w * 0.5, o.d * 0.52, o.h, $, {
    top: x(s.metalLight, "#8d9aa1", 0.3),
    south: s.metal,
    east: s.metalDark,
    edge: s.metalEdge
  });
  for (let G = 0; G < 3; G += 1) {
    const tt = o.h + 2.2 + G * 2;
    k(
      e,
      t.project(o.x + o.w * 0.28, o.y + o.d * 0.7 + 0.3, tt),
      t.project(o.x + o.w * 0.7, o.y + o.d * 0.7 + 0.3, tt),
      h(s.metalEdge, 0.55),
      0.7
    );
  }
  const F = o.x + o.w * 0.43, Y = o.y + o.d * 0.42;
  bt(t, F, Y, 3.2 * n, $, $ + 9 * c, {
    side: s.metal,
    sideDark: s.metalDark,
    top: s.metalLight,
    edge: s.metalEdge
  }), C(e, t.project(F, Y, $ + 9 * c), Math.max(0.8, 1.2 * n * t.scale), h(s.metalDark, 0.9));
  const ct = t.project(o.x + o.w * 0.66, o.y + o.d * 0.34, $ + 0.2), yt = Math.max(2.4, 4.2 * n * t.scale), B = yt * 0.52, pt = t.reduced ? 0.5 : t.time * (l ? 6e-3 : 14e-4) + g;
  e.beginPath(), e.ellipse(ct.x, ct.y, yt, B, 0, 0, f), e.strokeStyle = h(s.metalDark, 0.8), e.lineWidth = 0.9, e.stroke();
  for (let G = 0; G < 4; G += 1) {
    const tt = pt + G * f / 4;
    k(
      e,
      ct,
      { x: ct.x + Math.cos(tt) * yt * 0.86, y: ct.y + Math.sin(tt) * B * 0.86 },
      h(s.metalDark, 0.7),
      0.7
    );
  }
  if (C(e, ct, Math.max(0.8, 1.1 * t.scale), s.metalDark), l && !t.reduced)
    for (let G = 0; G < 3; G += 1) {
      const tt = (t.time * 22e-5 + G / 3) % 1, ot = t.project(F, Y, $ + 9 * c + 3 + tt * 15);
      e.beginPath(), e.ellipse(
        ot.x,
        ot.y,
        (2.4 + tt * 5) * n * t.scale,
        (1.4 + tt * 2.6) * n * t.scale,
        0,
        0,
        f
      ), e.fillStyle = h(s.frost, 0.18 * (1 - tt)), e.fill();
    }
  if (d) {
    const G = t.project((j + S) / 2, M, (D + W) / 2);
    wt(
      e,
      G,
      Math.max(10, o.w * 0.55 * t.scale),
      h(m, (l ? 0.42 : 0.2) * y),
      0.3
    );
  }
  Pt(t, t.project(j + 5 * n, M + 0.5, W + E * 0.6), u, g, 1), Pt(t, t.project(S - 5 * n, M + 0.5, W + E * 0.6), u, g + 1.7, 0.85), k(
    e,
    t.project(o.x + 4 * n, M, 2.2),
    t.project(o.x + o.w - 4 * n, M, 2.2),
    h(u, 0.6),
    1.1
  );
}
function Ta(t, a) {
  const e = typeof t == "number" ? t : Number(t);
  return Number.isFinite(e) ? e : a;
}
function Do(t, a) {
  const { x: e, y: s, w: o, d: n, h: r } = ue(a), c = t.ctx, i = t.theme, l = Fe(t, "#87949b"), d = me(t, a), p = _(Ta(a.meta?.dust, 0.12), 0, 1), u = Math.max(0, Ta(a.meta?.peakOutput, 0)), m = ge(a, 3), g = t.scale > 0.58;
  ae(t, e, s, o, n, 0.85), P(t, e + o * 0.015, s + n * 0.03, o * 0.97, n * 0.94, 0, Math.max(0.7, r * 0.025), {
    top: x(i.pad, i.ground, 0.45),
    south: x(i.padEdge, i.groundDark, 0.4),
    east: x(i.padEdge, i.groundDark, 0.55),
    edge: h(i.groundEdge, 0.45)
  });
  const y = 2, w = n * 0.33, v = n * 0.1, M = e + o * 0.05, j = e + o * 0.86, S = t.reduced ? 0 : Math.sin(t.time * 33e-5 + m) * r * 0.045, D = x(i.screen, "#4f8ba4", t.dark ? 0.38 : 0.64), W = x(i.metalLight, "#d7dde0", 0.4), N = Math.max(1.4, o * 0.02);
  for (let R = 0; R < y; R += 1) {
    const O = s + n * 0.07 + R * (w + v), Z = O + w, $ = r * 0.64, F = r * 0.38 + S * (R === 0 ? 1 : -0.8), Y = (B, pt) => t.project(M + (j - M) * B, O + w * pt, $ + (F - $) * pt), ct = [
      [M + o * 0.015, O + n * 0.015, $],
      [j - o * 0.015, O + n * 0.015, $],
      [M + o * 0.015, Z - n * 0.015, F],
      [j - o * 0.015, Z - n * 0.015, F]
    ];
    for (const [B, pt, G] of ct)
      P(t, B - N / 2, pt - N / 2, N, N, 0, Math.max(1, G - 0.5), {
        top: i.metalDark,
        south: i.metal,
        east: i.metalDark,
        edge: i.metalEdge
      });
    k(
      c,
      t.project(M, O, $ - 1),
      t.project(j, O, $ - 1),
      h(i.metalDark, 0.75),
      Math.max(0.8, 1.2 * t.scale)
    ), k(
      c,
      t.project(M, O, 1.4),
      t.project(j, O, 1.4),
      h(i.metalDark, 0.5),
      Math.max(0.7, 1 * t.scale)
    );
    const yt = [Y(0, 0), Y(1, 0), Y(1, 1), Y(0, 1)];
    if (b(c, yt, D), K(c, yt, W, Math.max(0.8, 1 * t.scale)), g) {
      for (let B = 1; B < 6; B += 1)
        k(c, Y(B / 6, 0.04), Y(B / 6, 0.96), h(W, 0.45), 0.6);
      for (let B = 1; B < 3; B += 1)
        k(c, Y(0.03, B / 3), Y(0.97, B / 3), h(W, 0.4), 0.6);
    }
    if (p > 0.02 && (c.save(), c.globalAlpha = 0.22 + p * 0.6, b(c, yt, i.dust), c.restore(), g))
      for (let B = 0; B < 5; B += 1) {
        const pt = T(a.id + R, B), G = T(a.id + R, B + 11);
        C(
          c,
          Y(0.08 + pt * 0.84, 0.12 + G * 0.76),
          Math.max(0.45, 1.1 * t.scale * (0.4 + p)),
          h(i.groundLight, 0.5)
        );
      }
    if (!t.reduced) {
      const B = (t.time * 7e-5 + m / 6.283 + R * 0.47) % 1.6 - 0.28;
      B > -0.16 && B < 1.02 && b(
        c,
        [Y(B, 0.02), Y(B + 0.12, 0.02), Y(B + 0.12, 0.98), Y(B, 0.98)],
        h("#ffffff", t.dark ? 0.08 : 0.18)
      );
    }
    k(
      c,
      t.project(M, Z, F + 0.4),
      t.project(j, Z, F + 0.4),
      h(i.metalDark, 0.45),
      0.8
    ), Pt(
      t,
      t.project(j - o * 0.02, Z - n * 0.02, F - 2),
      p > 0.62 ? i.warning : d,
      ge(a, R),
      0.55
    );
  }
  const L = e + o * 0.875, A = o * 0.105, q = s + n * 0.2, E = n * 0.3, H = r * 0.44;
  P(t, L, q, A, E, 0, H, {
    top: l.top,
    south: l.south,
    east: l.east,
    edge: l.edge,
    highlight: l.highlight
  });
  const J = X(t, L + A * 0.1, L + A * 0.9, q + E + 0.3, H * 0.16, H * 0.66);
  b(c, J, h(i.screen, 0.92)), K(c, J, h(i.metalDark, 0.6), 0.6);
  const z = _(Math.round(u / 18), 0, 4);
  for (let R = 0; R < 4; R += 1) {
    const O = L + A * (0.18 + R * 0.17), Z = O + A * 0.1, $ = H * 0.2, F = H * 0.6;
    if (b(c, X(t, O, Z, q + E + 0.4, $, F), h(i.metalDark, 0.5)), R < z) {
      const Y = 0.45 + T(a.id, R) * 0.5;
      b(
        c,
        X(t, O, Z, q + E + 0.5, $, $ + (F - $) * Y),
        h(d, 0.95)
      );
    }
  }
  for (let R = 0; R < 3; R += 1) {
    const O = H * (0.3 + R * 0.14);
    k(
      c,
      t.project(L + A, q + E * 0.2, O),
      t.project(L + A, q + E * 0.8, O),
      h(i.metalEdge, 0.55),
      0.7
    );
  }
  k(
    c,
    t.project(L + A * 0.5, q + E, 1.4),
    t.project(L - o * 0.05, q + E + 3, 1.4),
    h(i.metalDark, 0.8),
    Math.max(0.9, 1.4 * t.scale)
  ), k(
    c,
    t.project(L + A, q + E * 0.5, H * 0.24),
    t.project(e + o + 5, q + E * 0.5 + 2, 0.9),
    h(i.metalDark, 0.6),
    Math.max(0.8, 1.2 * t.scale)
  ), Pt(t, t.project(L + A * 0.86, q + E + 0.4, H * 0.86), d, ge(a, 9), 0.7);
}
const Ce = 4, we = 3;
function ba(t) {
  return typeof t == "number" && Number.isFinite(t) ? t : null;
}
function Eo(t, a) {
  const e = t.ctx, s = t.theme, o = ue(a), n = _(o.w / 64, 0.55, 1.6), r = _(o.d / 32, 0.55, 1.6), c = _(o.h / 58, 0.55, 1.6), i = _(2.4 * n, 1.5, 4), l = me(t, a), d = T(a.id, 7) * f, p = t.scale > 0.62;
  ae(t, o.x, o.y, o.w, o.d, 0.95), $e(a) && Ye(t, o.x + o.w / 2, o.y + o.d / 2, Math.max(o.w, o.d) * 0.7, l, t.dark ? 0.16 : 0.09);
  const u = a.meta ?? {}, m = {}, g = u.stock;
  if (g && typeof g == "object" && !Array.isArray(g))
    for (const [G, tt] of Object.entries(g)) {
      const ot = ba(tt);
      ot !== null && ot > 0 && (m[G] = ot);
    }
  const y = ba(u.total), w = [];
  for (const [G, tt] of Object.entries(m))
    for (let ot = 0; ot < Math.min(4, Math.floor(tt)); ot += 1) w.push(G);
  if (Object.keys(m).length > 0 || y !== null || w.push("filter", "pump", "crate", "crate", "filter", "pump", "crate"), y !== null)
    for (; w.length < Math.min(y, Ce * we); ) w.push("crate");
  const M = w.slice(0, Ce * we), j = y ?? w.length, S = (G) => 2 + G * (o.h - 6) / Ce, D = _(2.2 * n, 1.4, 3.4), W = o.x + i + 2 * n, N = Math.max(4, (o.w - 2 * i - 4 * n) / we), L = { top: s.metalDark, south: s.metal, east: s.metalDark, edge: s.metalEdge }, A = (G, tt) => P(t, G, tt, i, i, 0, o.h, L);
  P(t, o.x, o.y, o.w, Math.min(o.d * 0.12, 2.4), 0, o.h, {
    top: s.metalDark,
    south: x(s.metalDark, s.deviceFront, 0.35),
    east: s.metalDark,
    edge: s.metalEdge
  }), A(o.x, o.y), A(o.x + o.w - i, o.y);
  for (let G = 0; G < Ce; G += 1) {
    const tt = S(G);
    P(t, o.x, o.y, o.w, o.d, tt, tt + D, {
      top: x(s.metal, "#a58a68", 0.3),
      south: s.metalDark,
      east: s.metalDark,
      edge: s.metalEdge
    });
    for (let ot = 0; ot < we; ot += 1) {
      const nt = M[G * we + ot];
      if (!nt) continue;
      const Mt = (T(a.id + G, ot) - 0.5) * 2.4 * r, se = W + N * (ot + 0.5);
      fo(t, nt, se, o.y + o.d / 2 + Mt, tt + D, n, r, c, a.id + G + ot);
    }
  }
  const q = o.h - _(2.8 * n, 2, 4);
  P(t, o.x, o.y, o.w, 2 * r, q, o.h, L), P(t, o.x, o.y + o.d - 2 * r, o.w, 2 * r, q, o.h, L), A(o.x, o.y + o.d - i), A(o.x + o.w - i, o.y + o.d - i), k(
    e,
    t.project(o.x + o.w - 0.3, o.y + i, 4),
    t.project(o.x + o.w - 0.3, o.y + o.d - i, o.h - 6),
    h(s.metalDark, 0.5),
    0.8
  ), k(
    e,
    t.project(o.x + o.w - 0.3, o.y + o.d - i, 4),
    t.project(o.x + o.w - 0.3, o.y + i, o.h - 6),
    h(s.metalDark, 0.5),
    0.8
  );
  const E = o.h - 1.5, H = o.h - _(8 * n, 5, 11), J = X(t, o.x + o.w * 0.34, o.x + o.w * 0.66, o.y + o.d + 0.4, H, E);
  b(e, J, h(s.screen, 0.92)), K(e, J, h(s.metalEdge, 0.8), 0.8);
  const z = t.project(o.x + o.w / 2, o.y + o.d + 0.5, (H + E) / 2);
  jt(e, `${j} 件`, z.x, z.y, _(5.2 * n, 4, 8), s.screenGlow, 650);
  const R = _(13 * n, 9, 20), O = _(5 * r, 3, 7), Z = _(10 * c, 6, 13), $ = o.h * 0.5, F = o.x + o.w - i - R - 1.5 * n;
  P(t, F, o.y + o.d - O, R, O, $, $ + Z, {
    top: s.metalLight,
    south: s.metal,
    east: s.metalDark,
    edge: s.metalEdge
  });
  const Y = X(t, F + 2 * n, F + R - 2 * n, o.y + o.d + 0.3, $ + Z * 0.32, $ + Z * 0.86);
  Ut(t, Y, { variant: "bars", color: l, phase: T(a.id, 3), intensity: 0.9 }), k(
    e,
    t.project(F + R * 0.2, o.y + o.d + 0.3, $ + Z * 0.16),
    t.project(F + R * 0.8, o.y + o.d + 0.3, $ + Z * 0.16),
    h(s.metalDark, 0.6),
    0.7
  );
  const ct = t.reduced ? 0.62 : t.time * 16e-5 % 1, yt = _(3.6 * n, 2, 5.5), B = 4 + ct * (o.h - 12), pt = X(t, o.x + i, o.x + o.w - i, o.y + o.d + 0.6, B, B + yt);
  b(e, pt, h(s.screenGlow, t.reduced ? 0.06 : 0.1)), k(
    e,
    t.project(o.x + i, o.y + o.d + 0.7, B + yt),
    t.project(o.x + o.w - i, o.y + o.d + 0.7, B + yt),
    h(s.screenGlow, 0.28),
    0.7
  ), Ya(
    e,
    t.project(o.x + i, o.y + o.d + 0.7, B + yt / 2),
    Math.max(0.9, 1.1 * t.scale),
    h(s.screenGlow, 0.9),
    Math.max(4, 5 * t.scale),
    h(s.screenGlow, 0.25)
  ), Pt(t, t.project(o.x + o.w - i * 0.5, o.y + o.d + 0.5, o.h - 3.5), l, d, p ? 1 : 0.9);
}
function fo(t, a, e, s, o, n, r, c, i) {
  const l = t.theme, d = /filter|滤/.test(a), p = /pump|泵/.test(a), u = d ? l.water : p ? l.warning : "#b78a52";
  if (d) {
    const w = Math.min(4.4 * n, 5.6 * r), v = 9.2 * c, M = bt(t, e, s, w, o, o + v, {
      side: x(l.metalLight, u, 0.5),
      sideDark: x(l.metal, u, 0.45),
      top: x(l.metalLight, u, 0.3),
      edge: l.metalEdge
    });
    for (const j of [0.34, 0.68]) {
      const S = t.project(e, s, o + v * j);
      t.ctx.beginPath(), t.ctx.ellipse(S.x, S.y, M.rx, M.ry, 0, 0, Math.PI, !1), t.ctx.strokeStyle = h(l.metalDark, 0.55), t.ctx.lineWidth = 0.7, t.ctx.stroke();
    }
    C(t.ctx, t.project(e, s, o + v), Math.max(0.8, 1.1 * t.scale), h(l.metalDark, 0.8));
    return;
  }
  if (p) {
    const w = 11 * n, v = 10 * r, M = 5.4 * c;
    P(t, e - w / 2, s - v / 2, w, v, o, o + M, {
      top: x(l.deviceTop, u, 0.35),
      south: x(l.deviceSide, u, 0.3),
      east: x(l.deviceFront, u, 0.25),
      edge: l.deviceEdge
    }), bt(t, e + w * 0.18, s, Math.min(2.6 * n, 3.2 * r), o + M, o + M + 3 * c, {
      side: x(l.metalLight, u, 0.25),
      sideDark: x(l.metal, u, 0.25),
      top: l.metalLight,
      edge: l.metalEdge
    }), k(
      t.ctx,
      t.project(e - w * 0.3, s, o + M * 0.65),
      t.project(e - w * 0.52, s, o + M * 0.65),
      h(l.metalDark, 0.75),
      0.8
    ), C(t.ctx, t.project(e + w * 0.18, s, o + M + 3 * c), Math.max(0.6, 0.8 * t.scale), h(l.metalDark, 0.7));
    return;
  }
  const m = 12 * n, g = 10.5 * r, y = (6.8 + T(i, 2) * 1.8) * c;
  P(t, e - m / 2, s - g / 2, m, g, o, o + y, {
    top: x(l.deviceTop, u, 0.3),
    south: x(l.deviceSide, u, 0.26),
    east: x(l.deviceFront, u, 0.2),
    edge: l.deviceEdge
  }), k(
    t.ctx,
    t.project(e - m / 2, s + g / 2, o + y * 0.55),
    t.project(e + m / 2, s + g / 2, o + y * 0.55),
    h(l.deviceEdge, 0.5),
    0.7
  ), k(
    t.ctx,
    t.project(e, s + g / 2, o + 1),
    t.project(e, s + g / 2, o + y - 1),
    h(l.deviceEdge, 0.45),
    0.7
  );
}
const Lo = [
  ["freezer", /freezer|冷冻/],
  ["fridge", /cold|fridge|冷藏|cold-store/],
  ["growlight", /light|补光/],
  ["valve", /irrig|valve|阀/],
  ["probe", /sensor|probe|探针/],
  ["tank", /tank|储罐/],
  ["filter", /filter|过滤|water-module|水路/],
  ["pump", /pump|泵/],
  ["port", /port|采样点/],
  ["dispenser", /dispens|liquid-handler|分液/],
  ["centrifuge", /centrifuge|离心/],
  ["extractor", /extract|提取/],
  ["imager", /imag|成像/],
  ["instrument", /screen|confirm|analysis|assay|筛查|确认|分析/],
  ["incubator", /incubat|培养/],
  ["heater", /heat|恒温/],
  ["rack", /rack|货架|stock|库位/],
  ["cabinet", /cabinet|柜|tools|工具/],
  ["console", /console|终端/],
  ["bench", /bench|工作台/],
  ["diag", /diag|标定|诊断/],
  ["energy", /energy|能源|battery|备用电/]
];
function Io(t) {
  const a = `${t.id} ${t.name} ${t.subtitle ?? ""} ${String(t.meta?.kind ?? "")} ${String(t.meta?.category ?? "")}`.toLowerCase();
  for (const [e, s] of Lo)
    if (s.test(a)) return e;
  return "generic";
}
function Po(t) {
  switch (t) {
    case "tank":
    case "filter":
    case "pump":
      return "#9fb3bf";
    case "fridge":
    case "freezer":
      return "#9cc3d2";
    case "incubator":
    case "heater":
      return "#d7a25c";
    case "instrument":
    case "centrifuge":
    case "imager":
      return "#c7d2d8";
    case "rack":
    case "cabinet":
      return "#b99b74";
    case "console":
      return "#5d6b74";
    case "energy":
      return "#9aa6ad";
    case "growlight":
      return "#e0b060";
    default:
      return;
  }
}
function Ne(t, a) {
  const e = ue(a), s = [
    t.project(e.x, e.y, 0),
    t.project(e.x + e.w, e.y, 0),
    t.project(e.x, e.y + e.d, 0),
    t.project(e.x + e.w, e.y + e.d, 0),
    t.project(e.x, e.y, e.h),
    t.project(e.x + e.w, e.y, e.h),
    t.project(e.x, e.y + e.d, e.h),
    t.project(e.x + e.w, e.y + e.d, e.h)
  ], o = s.map((r) => r.x), n = s.map((r) => r.y);
  return {
    x: Math.min(...o),
    y: Math.min(...n),
    w: Math.max(4, Math.max(...o) - Math.min(...o)),
    h: Math.max(4, Math.max(...n) - Math.min(...n))
  };
}
const Co = {
  "solar-array": Do,
  battery: So,
  "co2-tank": To,
  spares: Eo,
  "quarantine-bay": bo
};
function Ao(t, a) {
  const e = Co[String(a.meta?.kind ?? "")];
  if (e) {
    e(t, a);
    const m = Ne(t, a);
    t.hits.push({
      id: a.id,
      kind: "entity",
      x: m.x,
      y: m.y,
      w: m.w,
      h: m.h,
      depth: a.x + a.y + 10
    }), (t.selected === a.id || t.hoverId === a.id || t.scale > 1.7) && aa(t, a, { x: m.x + m.w / 2, y: m.y }, { tone: $e(a) ? me(t, a) : void 0 });
    return;
  }
  t.ctx;
  const s = ue(a), o = Io(a), n = Po(o), r = Fe(t, n), c = me(t, a), i = $e(a), l = T(a.id, 7) * f, d = t.scale > 0.62;
  switch (ae(t, s.x, s.y, s.w, s.d, 0.95), i && Ye(t, s.x + s.w / 2, s.y + s.d / 2, Math.max(s.w, s.d) * 0.9, c, t.dark ? 0.2 : 0.12), o) {
    case "tank":
      $o(t, a, s, r, c);
      break;
    case "filter":
      No(t, a, s, r, c);
      break;
    case "pump":
      Ro(t, a, s, r, c);
      break;
    case "port":
      Fo(t, a, s, r, c);
      break;
    case "dispenser":
      Bo(t, a, s, r, c);
      break;
    case "centrifuge":
      Yo(t, a, s, r, c);
      break;
    case "extractor":
      Go(t, a, s, r, c);
      break;
    case "instrument":
      Xo(t, a, s, r, c);
      break;
    case "imager":
      Oo(t, a, s, r, c);
      break;
    case "fridge":
    case "freezer":
      _o(t, a, s, r, c, o === "freezer");
      break;
    case "rack":
      qo(t, a, s, r, c);
      break;
    case "cabinet":
      Zo(t, a, s, r, c);
      break;
    case "console":
      Uo(t, a, s, r, c);
      break;
    case "bench":
      Vo(t, a, s, r, c);
      break;
    case "diag":
      Ko(t, a, s, r, c);
      break;
    case "energy":
      Jo(t, a, s, r, c);
      break;
    case "incubator":
      Qo(t, a, s, r, c);
      break;
    case "heater":
      zo(t, a, s, r, c);
      break;
    case "growlight":
      tn(t, a, s, r, c);
      break;
    case "valve":
      an(t, a, s, r, c);
      break;
    case "probe":
      sn(t, a, s, r, c);
      break;
    default:
      on(t, a, s, r, c);
  }
  const p = t.project(s.x + s.w * 0.84, s.y + s.d + 0.4, Math.max(4, s.h * 0.62));
  if (Pt(t, p, c, l, 1), d && s.h > 12) {
    const m = t.project(s.x + s.w * 0.22, s.y + s.d + 0.4, 1), g = t.project(s.x + s.w * 0.22 - 8, s.y + s.d + 8, 0.6);
    Va(t, m, g, h(t.theme.metalDark, 0.55));
  }
  const u = Ne(t, a);
  t.hits.push({
    id: a.id,
    kind: "entity",
    x: u.x,
    y: u.y,
    w: u.w,
    h: u.h,
    depth: a.x + a.y + 10
  }), (t.selected === a.id || t.hoverId === a.id || t.scale > 1.7) && aa(t, a, { x: u.x + u.w / 2, y: u.y }, { tone: i ? c : void 0 });
}
function Wo(t, a, e) {
  return [
    t.project(a.x, a.y, e),
    t.project(a.x + a.w, a.y, e),
    t.project(a.x + a.w, a.y + a.d, e),
    t.project(a.x, a.y + a.d, e)
  ];
}
function Yt(t, a, e, s = 0, o = a.h) {
  P(t, a.x, a.y, a.w, a.d, s, o, {
    top: e.top,
    south: e.south,
    east: e.east,
    edge: e.edge,
    highlight: e.highlight
  });
}
function Ge(t, a, e) {
  return t.project(a.x + a.w / 2, a.y + a.d + 0.4, e);
}
function $o(t, a, e, s, o) {
  const n = t.ctx, r = t.theme, c = e.x + e.w / 2, i = e.y + e.d / 2, l = Math.min(e.w, e.d) * 0.44;
  Me(t, e.x + 2, e.y + 2, e.w - 4, e.d - 4, 0.6, h(r.metalDark, 0.35));
  for (const [w, v] of [
    [e.x + 6, e.y + 6],
    [e.x + e.w - 6, e.y + 6],
    [e.x + 6, e.y + e.d - 6],
    [e.x + e.w - 6, e.y + e.d - 6]
  ])
    P(t, w - 2, v - 2, 4, 4, 0, 3, { top: r.metalDark, south: r.metalDark, east: r.metalDark, edge: r.metalEdge });
  const d = bt(t, c, i, l, 3, e.h - 4, {
    side: x(r.metalLight, "#9db4c0", 0.3),
    sideDark: x(r.metal, "#7f97a4", 0.32),
    top: x(r.metalLight, "#c9d9e0", 0.4),
    edge: r.metalEdge
  });
  for (const w of [0.24, 0.52, 0.8]) {
    const v = 3 + (e.h - 7) * w, M = t.project(c, i, v);
    n.beginPath(), n.ellipse(M.x, M.y, d.rx, d.ry, 0, 0, Math.PI, !1), n.strokeStyle = h(r.metalDark, 0.55), n.lineWidth = Math.max(0.7, 1.2 * t.scale), n.stroke();
  }
  const p = t.project(c + l * 0.55, i, 6), u = _(Number(a.meta?.water ?? 40) / Math.max(1, Number((a.meta?.capacity ?? "5000 L").toString().replace(/[^0-9]/g, "")) || 5e3), 0.08, 0.96), m = t.project(c + l * 0.55, i, 6 + (e.h - 12) * u);
  k(n, p, m, h(r.water, 0.8), Math.max(1.4, 2 * t.scale));
  const g = t.reduced ? 0 : Math.sin(t.time * 2e-3) * 0.8;
  if (k(n, m, { x: m.x + g, y: m.y - 1 }, h(r.waterLight, 0.9), 1), t.scale > 0.55) {
    const w = c - l * 0.82, v = t.project(w, i + l * 0.18, 2), M = t.project(w, i + l * 0.18, e.h - 2), j = t.project(w, i + l * 0.5, 2), S = t.project(w, i + l * 0.5, e.h - 2);
    k(n, v, M, r.metalDark, 0.9), k(n, j, S, r.metalDark, 0.9);
    for (let D = 0; D < 8; D += 1) {
      const W = 4 + D * ((e.h - 8) / 8);
      k(n, t.project(w, i + l * 0.18, W), t.project(w, i + l * 0.5, W), r.metalDark, 0.7);
    }
  }
  ye(t, Ge(t, e, e.h * 0.5), Math.max(2.4, 3.2 * t.scale), u, o);
  const y = t.project(c, i, e.h - 4);
  n.beginPath(), n.ellipse(y.x, y.y, d.rx * 0.3, d.ry * 0.3, 0, 0, f), n.fillStyle = h(r.metalDark, 0.75), n.fill(), n.strokeStyle = r.metalEdge, n.stroke(), k(n, t.project(c + l * 0.7, i, 4), t.project(e.x + e.w + 12, e.y + e.d * 0.5, 4), h(r.water, 0.7), Math.max(1.2, 2 * t.scale));
}
function No(t, a, e, s, o) {
  const n = t.ctx, r = t.theme, c = Math.min(e.w, e.d) * 0.23, i = e.h - 2;
  for (const l of [-1, 1]) {
    const d = e.x + e.w / 2 + l * e.w * 0.22;
    bt(t, d, e.y + e.d / 2, c, 2, i, {
      side: l < 0 ? r.metalLight : x(r.metalLight, "#c8d2cf", 0.4),
      sideDark: r.metal,
      top: r.metalLight,
      edge: r.metalEdge
    });
  }
  k(n, t.project(e.x + e.w * 0.28, e.y + e.d / 2, i), t.project(e.x + e.w * 0.72, e.y + e.d / 2, i), h(r.metalDark, 0.8), Math.max(1.2, 2 * t.scale)), ye(t, Ge(t, e, i * 0.6), Math.max(2.2, 3 * t.scale), _(Number(a.meta?.water ?? 45) / 100, 0.1, 1), o), k(n, t.project(e.x + e.w * 0.38, e.y + e.d, 6), t.project(e.x + e.w * 0.38, e.y + e.d + 12, 1), h(r.water, 0.55), 1.4);
}
function Ro(t, a, e, s, o) {
  const n = t.ctx, r = t.theme;
  Yt(t, e, s, 0, e.h * 0.55);
  const c = e.x + e.w / 2, i = e.y + e.d / 2;
  bt(t, c, i, e.w * 0.26, e.h * 0.45, e.h, {
    side: r.metalLight,
    sideDark: r.metal,
    top: x(r.metalLight, "#d7dde0", 0.5),
    edge: r.metalEdge
  });
  const l = Ge(t, e, e.h * 0.72), d = Math.max(2.2, e.w * 0.2 * t.scale);
  n.beginPath(), n.arc(l.x, l.y, d, 0, f), n.fillStyle = h(r.metalDark, 0.45), n.fill();
  const p = t.reduced ? 0.3 : t.time * 8e-3;
  for (let u = 0; u < 4; u += 1) {
    const m = p + u / 4 * f;
    k(
      n,
      l,
      { x: l.x + Math.cos(m) * d * 0.85, y: l.y + Math.sin(m) * d * 0.85 },
      h(r.metalLight, 0.9),
      1
    );
  }
  C(n, l, Math.max(0.8, d * 0.16), o), k(n, t.project(c + e.w * 0.3, e.y + e.d, e.h * 0.4), t.project(c + e.w * 0.65, e.y + e.d + 14, 2), h(r.water, 0.7), 1.6);
}
function Fo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme;
  Yt(t, e, s, 0, e.h * 0.6);
  const c = e.x + e.w / 2, i = e.y + e.d / 2;
  bt(t, c, i, e.w * 0.16, e.h * 0.6, e.h, {
    side: r.metalLight,
    sideDark: r.metal,
    top: r.metalLight,
    edge: r.metalEdge
  });
  const l = t.project(c, i, e.h + 3);
  n.beginPath(), n.ellipse(l.x, l.y, Math.max(2, 4 * t.scale), Math.max(1.2, 2.2 * t.scale), 0, 0, f), n.strokeStyle = o, n.lineWidth = 1, n.stroke();
  const d = t.reduced ? 0 : t.time * 1e-3;
  for (let u = 0; u < 4; u += 1) {
    const m = d + u / 4 * f;
    k(n, l, { x: l.x + Math.cos(m) * 4 * t.scale, y: l.y + Math.sin(m) * 2.2 * t.scale }, h(o, 0.9), 0.7);
  }
  const p = t.project(c + e.w * 0.3, i, e.h * 0.5);
  n.beginPath(), n.moveTo(p.x, p.y), n.quadraticCurveTo(p.x + 8, p.y + 4, p.x + 6, p.y + 12), n.strokeStyle = h(r.water, 0.75), n.lineWidth = 1.4, n.stroke();
}
function Bo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme;
  Yt(t, e, s, 0, e.h), k(n, t.project(e.x + 4, e.y + 8, e.h + 6), t.project(e.x + e.w - 4, e.y + 8, e.h + 6), r.metalDark, 1);
  const c = t.reduced ? 0.5 : (Math.sin(t.time * 12e-4) + 1) / 2, i = e.x + 8 + (e.w - 16) * c;
  P(t, i - 2, e.y + 6, 5, 5, e.h + 2, e.h + 8, {
    top: r.metalLight,
    south: r.metal,
    east: r.metalDark,
    edge: r.metalEdge
  }), k(n, t.project(i, e.y + 8, e.h + 2), t.project(i, e.y + 8, e.h - 6), h(r.metalDark, 0.8), 1);
  const l = t.project(e.x + e.w * 0.5, e.y + e.d + 0.5, e.h * 0.34);
  for (let p = 0; p < 4; p += 1)
    Be(
      n,
      l.x - 9 + p * 6,
      l.y + 3,
      Math.max(3, 7 * t.scale),
      [r.sample, r.water, r.fruit, r.sampleLight][p] ?? r.sample
    );
  const d = X(t, e.x + e.w * 0.62, e.x + e.w * 0.9, e.y + e.d, e.h * 0.52, e.h * 0.82);
  Ut(t, d, { variant: "bars", color: o, phase: T(a.id, 2) }), ca(t, X(t, e.x, e.x + e.w, e.y + e.d, 0, e.h), h(r.deviceEdge, 0.4), 4);
}
function Yo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme;
  Yt(t, e, s, 0, e.h);
  const c = t.project(e.x + e.w / 2, e.y + e.d / 2, e.h), i = e.w * 0.3 * t.scale, l = e.w * 0.15 * t.scale;
  n.beginPath(), n.ellipse(c.x, c.y, i, l, 0, 0, f), n.fillStyle = h(r.metalDark, 0.75), n.fill(), n.strokeStyle = r.metalEdge, n.lineWidth = 0.8, n.stroke();
  const d = $e(a) && !t.reduced ? t.time * 0.02 : 0.4;
  for (let u = 0; u < 3; u += 1) {
    const m = d + u / 3 * f;
    k(
      n,
      c,
      { x: c.x + Math.cos(m) * i * 0.75, y: c.y + Math.sin(m) * l * 0.75 },
      h(o, 0.85),
      1.2
    );
  }
  C(n, c, Math.max(0.8, 1.4 * t.scale), h("#ffffff", 0.7));
  const p = X(t, e.x + e.w * 0.12, e.x + e.w * 0.5, e.y + e.d, e.h * 0.2, e.h * 0.55);
  Ut(t, p, { variant: "wave", color: o, phase: T(a.id, 3) });
  for (let u = 0; u < 3; u += 1) {
    const m = t.project(e.x + e.w * (0.62 + u * 0.1), e.y + e.d + 0.4, e.h * 0.36);
    C(n, m, Math.max(0.8, 1.4 * t.scale), u === 0 ? o : h(r.metalDark, 0.7));
  }
  k(n, t.project(e.x + e.w * 0.15, e.y + e.d * 0.3, e.h), t.project(e.x + e.w * 0.15, e.y + e.d * 0.7, e.h), r.metalDark, 1);
}
function Go(t, a, e, s, o) {
  const n = t.ctx, r = t.theme;
  Yt(t, e, s, 0, e.h);
  for (const i of [-1, 1]) {
    const l = e.x + e.w / 2 + i * e.w * 0.2, d = e.w * 0.11;
    bt(t, l, e.y + e.d / 2, d, e.h, e.h + 16, {
      side: h(r.glass, 0.9),
      sideDark: h(r.glassEdge, 0.8),
      top: r.metalLight,
      edge: r.metalEdge
    });
    const p = t.project(l, e.y + e.d / 2, e.h + 3), u = p.y - 10 * t.scale * (0.5 + i * 0.12);
    if (k(n, p, { x: p.x, y: u }, h(r.water, 0.55), Math.max(1.2, d * 1.1 * t.scale)), !t.reduced)
      for (let m = 0; m < 3; m += 1) {
        const g = (t.time * 4e-4 + m / 3 + (i > 0 ? 0.2 : 0)) % 1;
        C(n, { x: p.x + Math.sin(g * 6) * d * 0.4 * t.scale, y: p.y - g * 10 * t.scale }, Math.max(0.5, 0.9 * t.scale), h("#ffffff", 0.6));
      }
  }
  k(n, t.project(e.x + e.w * 0.3, e.y + e.d / 2, e.h + 14), t.project(e.x + e.w * 0.7, e.y + e.d / 2, e.h + 14), h(r.metalDark, 0.8), 1.4);
  const c = X(t, e.x + e.w * 0.24, e.x + e.w * 0.78, e.y + e.d, e.h * 0.36, e.h * 0.72);
  Ut(t, c, { variant: "bars", color: o, phase: T(a.id, 5) });
}
function Xo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme;
  Yt(t, e, s, 0, e.h), Ho(t, e);
  const c = X(t, e.x + e.w * 0.1, e.x + e.w * 0.9, e.y + e.d, e.h * 0.42, e.h * 0.86);
  Ut(t, c, { variant: "wave", color: o, phase: T(a.id, 4) });
  for (let i = 0; i < 4; i += 1) {
    const l = t.project(e.x + e.w * (0.16 + i * 0.16), e.y + e.d + 0.4, e.h * 0.24);
    C(n, l, Math.max(0.7, 1.2 * t.scale), i === 0 ? o : h(r.metalDark, 0.55));
  }
  for (let i = 0; i < 4; i += 1) {
    const l = e.h * (0.2 + i * 0.08);
    k(n, t.project(e.x + e.w, e.y + e.d * 0.18, l), t.project(e.x + e.w, e.y + e.d * 0.82, l), h(r.metalEdge, 0.5), 0.8);
  }
  a.meta?.temperature !== void 0 && Ka(t, `${Number(a.meta.temperature).toFixed(1)}°C`, t.project(e.x + e.w * 0.5, e.y + e.d * 0.5, e.h + 4), { size: 8 });
}
function Ho(t, a) {
  const e = t.theme, s = t.project(a.x + a.w * 0.5, a.y + a.d * 0.5, a.h + 0.2), o = a.w * 0.22 * t.scale, n = a.d * 0.11 * t.scale, r = t.ctx;
  r.beginPath(), r.ellipse(s.x, s.y, o, n, 0, 0, f), r.fillStyle = h(e.metalDark, 0.6), r.fill(), r.strokeStyle = h(e.metalEdge, 0.7), r.lineWidth = 0.7, r.stroke();
}
function Oo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme;
  Yt(t, e, s, 0, e.h);
  const c = t.reduced ? 0.5 : (Math.sin(t.time * 9e-4) + 1) / 2, i = e.y + 6 + (e.d - 24) * c;
  P(t, e.x + 5, i, e.w - 10, 12, e.h, e.h + 3, {
    top: r.metalLight,
    south: r.metal,
    east: r.metalDark,
    edge: r.metalEdge
  });
  const l = t.reduced ? 0.5 : t.time * 5e-4 % 1, d = e.h + 4, p = t.project(e.x + 6 + (e.w - 12) * l, i, d), u = t.project(e.x + 6 + (e.w - 12) * l, i + 12, d);
  k(n, p, u, h(o, 0.9), Math.max(1, 1.6 * t.scale));
  const m = t.project(e.x + 6 + (e.w - 12) * l, i + 6, d);
  wt(n, m, Math.max(4, 10 * t.scale), h(o, 0.4), 0.3);
  const g = Ge(t, e, e.h * 0.7);
  n.beginPath(), n.arc(g.x, g.y, Math.max(1.6, 2.6 * t.scale), 0, f), n.fillStyle = h("#162226", 0.85), n.fill(), n.strokeStyle = o, n.lineWidth = 0.8, n.stroke();
  const y = X(t, e.x + e.w * 0.55, e.x + e.w * 0.9, e.y + e.d, e.h * 0.2, e.h * 0.5);
  Ut(t, y, { variant: "grid", color: o, phase: T(a.id, 6) });
}
function _o(t, a, e, s, o, n) {
  const r = t.ctx, c = t.theme;
  Yt(t, e, s, 0, e.h);
  const i = e.h * 0.18, l = e.h * 0.9, d = e.x + 5, p = e.x + e.w - 5, u = X(t, d, p, e.y + e.d, i, l);
  b(r, X(t, e.x, e.x + e.w, e.y + e.d, 0, 3), h(c.metalDark, 0.85)), P(t, e.x + e.w * 0.18, e.y + e.d * 0.3, e.w * 0.64, e.d * 0.4, e.h, e.h + 5, {
    top: x("#a9c4cf", c.metalDark, 0.18),
    south: x("#93b2be", c.metalDark, 0.2),
    east: x("#75929d", c.metalDark, 0.2),
    edge: c.metalEdge
  });
  for (let y = 0; y < 3; y += 1) {
    const w = e.h + 1.6 + y * 1.5;
    k(
      r,
      t.project(e.x + e.w * 0.2, e.y + e.d * 0.72, w),
      t.project(e.x + e.w * 0.8, e.y + e.d * 0.72, w),
      h(c.metalEdge, 0.6),
      0.7
    );
  }
  if (n) {
    b(r, u, x(c.deviceSide, "#9db9c4", t.dark ? 0.2 : 0.35)), K(r, u, h(c.metalEdge, 0.7), 0.9), k(r, t.project(p - 6, e.y + e.d, i + 4), t.project(p - 6, e.y + e.d, l - 6), c.metalDark, 1.4);
    for (let y = 0; y < 5; y += 1) {
      const w = t.project(d + 4 + T(a.id, y) * (p - d - 8), e.y + e.d, i + 3 + T(a.id, y + 9) * (l - i - 6));
      r.beginPath(), r.arc(w.x, w.y, Math.max(0.6, 1.2 * t.scale), 0, f), r.fillStyle = h("#ffffff", 0.35), r.fill();
    }
  } else {
    b(r, u, h(c.screen, t.dark ? 0.7 : 0.55));
    for (let y = 1; y < 4; y += 1) {
      const w = i + (l - i) / 4 * y;
      k(r, t.project(d, e.y + e.d + 0.2, w), t.project(p, e.y + e.d + 0.2, w), h(c.metalDark, 0.6), 0.9);
      for (let v = 0; v < 4; v += 1) {
        const M = d + 4 + v * ((p - d - 8) / 4), j = t.project(M, e.y + e.d + 0.3, w + 1);
        Be(
          r,
          j.x,
          j.y,
          Math.max(2, 5 * t.scale),
          [c.sample, c.water, c.fruit, c.sampleLight][v] ?? c.sample
        );
      }
    }
    if (b(r, u, h(c.glass, 0.32)), K(r, u, h(c.glassEdge, 0.85), 0.9), k(
      r,
      t.project(d + (p - d) * 0.2, e.y + e.d + 0.4, i + 3),
      t.project(d + (p - d) * 0.2, e.y + e.d + 0.4, l - 3),
      h("#ffffff", t.dark ? 0.1 : 0.28),
      1.4
    ), t.dark) {
      const y = t.project((d + p) / 2, e.y + e.d, (i + l) / 2);
      wt(r, y, Math.max(6, e.w * 0.4 * t.scale), h(c.glowCool, 0.5), 0.3);
    }
  }
  K(r, u, h(c.metalDark, 0.9), 1.5), k(r, t.project(d, e.y + e.d + 0.3, i + 1.4), t.project(p, e.y + e.d + 0.3, i + 1.4), h(o, 0.75), 1.3);
  const m = Number(a.meta?.temperature ?? (n ? -18 : 4)), g = X(t, e.x + e.w * 0.6, e.x + e.w * 0.92, e.y + e.d + 0.4, e.h * 0.9, e.h * 0.96);
  if (b(r, g, h(c.screen, 0.88)), K(r, g, h(c.metalDark, 0.65), 0.7), t.scale > 0.55) {
    const y = t.project(e.x + e.w * 0.76, e.y + e.d + 0.5, e.h * 0.93);
    jt(r, `${m.toFixed(0)}°`, y.x, y.y, Math.max(4, Math.min(8, 5.4 * t.scale)), c.screenGlow, 700);
  }
  if (n && !t.reduced)
    for (let y = 0; y < 3; y += 1) {
      const w = (t.time * 2e-4 + y / 3) % 1, v = t.project(e.x + e.w * (0.2 + y * 0.3), e.y + e.d + 6 + w * 12, 2 + w * 6);
      r.beginPath(), r.ellipse(v.x, v.y, (5 + w * 9) * t.scale, (2 + w * 3) * t.scale, 0, 0, f), r.fillStyle = h(c.frost, 0.22 * (1 - w)), r.fill();
    }
}
function qo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme, c = 2.4;
  for (const [l, d] of [
    [e.x, e.y],
    [e.x + e.w - c, e.y],
    [e.x, e.y + e.d - c],
    [e.x + e.w - c, e.y + e.d - c]
  ])
    P(t, l, d, c, c, 0, e.h, { top: r.metalDark, south: r.metal, east: r.metalDark, edge: r.metalEdge });
  const i = 3;
  for (let l = 0; l < i; l += 1) {
    const d = e.h / i * l + 3;
    P(t, e.x, e.y, e.w, e.d, d, d + 2, {
      top: x(r.metal, "#a58a68", 0.3),
      south: r.metalDark,
      east: r.metalDark,
      edge: r.metalEdge
    });
    const p = 3;
    for (let u = 0; u < p; u += 1) {
      if (T(a.id + l, u) < 0.24) continue;
      const m = (e.w - 8) / p - 2, g = e.x + 4 + u * ((e.w - 8) / p), y = 5 + T(a.id + l, u) * 4;
      P(t, g, e.y + 3, m, Math.max(4, e.d - 6), d + 2, Math.min(e.h, d + 2 + y), {
        top: x(r.deviceTop, o, 0.12),
        south: x(r.deviceSide, o, 0.1),
        east: r.deviceFront,
        edge: r.deviceEdge
      });
    }
  }
  K(t.ctx, Wo(t, e, e.h), h(r.metalEdge, 0.5), 0.7), k(n, t.project(e.x, e.y + e.d, e.h * 0.5), t.project(e.x + e.w, e.y + e.d, e.h * 0.5), h(r.metalEdge, 0.35), 0.7);
}
function Zo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme;
  Yt(t, e, s, 0, e.h);
  const c = e.x + 4, i = e.x + e.w - 4, l = X(t, c, i, e.y + e.d, 2, e.h - 3);
  K(n, l, h(r.metalEdge, 0.6), 0.8), k(n, t.project((c + i) / 2, e.y + e.d + 0.2, 2), t.project((c + i) / 2, e.y + e.d + 0.2, e.h - 3), h(r.metalEdge, 0.6), 0.8);
  for (const p of [-1, 1]) {
    const u = (c + i) / 2 + p * 6;
    k(n, t.project(u, e.y + e.d + 0.2, e.h * 0.42), t.project(u, e.y + e.d + 0.2, e.h * 0.58), r.metalDark, 1.2);
  }
  const d = X(t, e.x + e.w * 0.3, e.x + e.w * 0.7, e.y + e.d, e.h * 0.72, e.h * 0.82);
  b(n, d, h(r.labelBg, 0.8)), K(n, d, h(o, 0.4), 0.7), ca(t, X(t, e.x, e.x + e.w, e.y + e.d, 0, e.h), h(r.wallEdge, 0.3), 3);
}
function Uo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme, c = e.h * 0.5;
  P(t, e.x, e.y + e.d * 0.32, e.w, e.d * 0.68, 0, c, {
    top: x(r.deviceTop, o, 0.2),
    south: s.south,
    east: s.east,
    edge: s.edge
  });
  for (const l of [-1, 1]) {
    const d = e.x + e.w * (l < 0 ? 0.3 : 0.7), p = e.w * 0.3;
    P(t, d - p / 2, e.y + e.d * 0.4, p, 3, c, c + 4, {
      top: r.metalDark,
      south: r.metal,
      east: r.metalDark,
      edge: r.metalEdge
    });
    const u = X(t, d - p / 2 + 1, d + p / 2 - 1, e.y + e.d * 0.4 + 3, c + 5, c + 16);
    Ut(t, u, { variant: l < 0 ? "wave" : "bars", color: o, phase: T(a.id, l < 0 ? 1 : 2) });
  }
  const i = X(t, e.x + e.w * 0.38, e.x + e.w * 0.62, e.y + e.d * 0.9, c + 0.6, c + 1);
  b(n, i, h(r.metalDark, 0.85)), P(t, e.x + 3, e.y + e.d * 0.72, e.w * 0.14, e.d * 0.18, 0, e.h * 0.8, {
    top: r.metalDark,
    south: r.metal,
    east: r.metalDark,
    edge: r.metalEdge
  });
}
function Vo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme, c = e.h * 0.72;
  P(t, e.x, e.y, e.w, e.d, c, c + 4, {
    top: x(r.metalLight, "#c9b28f", 0.3),
    south: r.metal,
    east: r.metalDark,
    edge: r.metalEdge
  });
  for (const [i, l] of [
    [e.x + 3, e.y + 3],
    [e.x + e.w - 6, e.y + 3],
    [e.x + 3, e.y + e.d - 6],
    [e.x + e.w - 6, e.y + e.d - 6]
  ])
    P(t, i, l, 3, 3, 0, c, { top: r.metalDark, south: r.metal, east: r.metalDark, edge: r.metalEdge });
  P(t, e.x + e.w * 0.62, e.y + e.d * 0.3, 10, 7, c + 4, c + 10, {
    top: x(r.metal, "#6f7a80", 0.4),
    south: r.metalDark,
    east: r.metalDark,
    edge: r.metalEdge
  });
  for (let i = 0; i < 3; i += 1) {
    const l = e.y + e.d * (0.2 + i * 0.16);
    k(n, t.project(e.x + e.w * 0.2, l, c + 5), t.project(e.x + e.w * 0.34, l, c + 5), h(o, 0.9), 1.4);
  }
  P(t, e.x + 4, e.y + 3, e.w - 8, 3, c + 4, c + 20, {
    top: x(r.metalLight, "#b9a184", 0.3),
    south: r.metal,
    east: r.metalDark,
    edge: r.metalEdge
  });
  for (let i = 0; i < 4; i += 1) {
    const l = e.x + 10 + i * ((e.w - 20) / 3), d = t.project(l, e.y + 6, c + 12);
    C(n, d, Math.max(0.6, 1 * t.scale), h(r.metalDark, 0.7)), k(n, d, { x: d.x, y: d.y + 4 * t.scale }, h(o, 0.8), 1);
  }
}
function Ko(t, a, e, s, o) {
  const n = t.ctx, r = t.theme;
  P(t, e.x, e.y, e.w, e.d, 0, e.h * 0.35, {
    top: s.top,
    south: s.south,
    east: s.east,
    edge: s.edge
  });
  const c = e.x + e.w / 2, i = e.y + e.d / 2;
  bt(t, c, i, e.w * 0.1, e.h * 0.35, e.h, {
    side: r.metalLight,
    sideDark: r.metal,
    top: r.metalLight,
    edge: r.metalEdge
  });
  const l = t.reduced ? 0.4 : t.time * 14e-4, d = t.project(c, i, e.h + 6);
  k(n, d, { x: d.x + Math.cos(l) * 12 * t.scale, y: d.y + Math.sin(l) * 6 * t.scale - 2 }, r.metalDark, 1.2);
  const p = { x: d.x + Math.cos(l) * 12 * t.scale, y: d.y + Math.sin(l) * 6 * t.scale - 2 };
  if (n.beginPath(), n.arc(p.x, p.y, Math.max(2, 4 * t.scale), 0, f), n.fillStyle = h(r.labelBg, 0.9), n.fill(), n.strokeStyle = o, n.lineWidth = 1, n.stroke(), C(n, p, Math.max(0.6, 1 * t.scale), o), !t.reduced) {
    const m = t.time * 4e-4 % 1;
    k(n, p, { x: p.x + 20 * t.scale, y: p.y + 8 * t.scale + m * 2 }, h(o, 0.5), 0.8);
  }
  const u = X(t, e.x + e.w * 0.14, e.x + e.w * 0.5, e.y + e.d, e.h * 0.08, e.h * 0.28);
  Ut(t, u, { variant: "wave", color: o, phase: T(a.id, 2) });
}
function Jo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme, c = 4, i = 2, l = 2, d = 2, p = (e.w - d * (i + 1)) / i, u = (e.d - d * (l + 1)) / l;
  for (let m = 0; m < c; m += 1) {
    const g = m % i, y = Math.floor(m / i), w = e.x + d + g * (p + d), v = e.y + d + y * (u + d);
    P(t, w, v, p, u, 1, e.h * (0.55 + y * 0.35), {
      top: x(r.deviceTop, "#7b8b93", 0.25),
      south: x(r.deviceSide, "#6f7d84", 0.28),
      east: x(r.deviceFront, "#5c686e", 0.3),
      edge: r.deviceEdge
    });
    const j = 0.45 + T(a.id, m) * 0.5, S = X(t, w + 3, w + p - 3, v + u, e.h * (0.2 + y * 0.3), e.h * (0.24 + y * 0.3));
    b(n, S, h(o, 0.85));
    const D = t.project(w + p * j, v + u, e.h * (0.22 + y * 0.3));
    wt(n, D, Math.max(2, 5 * t.scale), h(o, 0.35), 0.4);
  }
  k(n, t.project(e.x + 2, e.y + e.d + 2, 2), t.project(e.x + e.w - 2, e.y + e.d + 2, 2), h(r.metalDark, 0.7), 1.6);
}
function Qo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme;
  Yt(t, e, s, 0, e.h);
  const c = X(t, e.x + 5, e.x + e.w - 5, e.y + e.d, e.h * 0.14, e.h * 0.9);
  b(n, c, h(r.glass, 0.55)), K(n, c, h(r.glassEdge, 0.8), 0.9);
  for (let i = 1; i < 4; i += 1) {
    const l = e.h * (0.14 + 0.19 * i);
    k(n, t.project(e.x + 6, e.y + e.d + 0.2, l), t.project(e.x + e.w - 6, e.y + e.d + 0.2, l), h(r.metalDark, 0.55), 0.8);
    for (let d = 0; d < 3; d += 1) {
      const p = t.project(e.x + 10 + d * ((e.w - 20) / 3), e.y + e.d + 0.3, l + 1);
      Be(n, p.x, p.y, Math.max(2, 4 * t.scale), h(r.sample, 0.9));
    }
  }
  if (t.dark) {
    const i = t.project(e.x + e.w / 2, e.y + e.d, e.h * 0.5);
    wt(n, i, Math.max(6, e.w * 0.4 * t.scale), h(r.glowWarm, 0.4), 0.3);
  }
  ye(t, t.project(e.x + e.w * 0.82, e.y + e.d, e.h * 0.72), Math.max(1.8, 2.6 * t.scale), 0.62, o);
}
function zo(t, a, e, s, o) {
  const n = t.ctx, r = t.theme, c = Math.max(4, e.h * 0.3);
  for (const [d, p] of [
    [e.x + 4, e.y + 4],
    [e.x + e.w - 6, e.y + 4],
    [e.x + 4, e.y + e.d - 6],
    [e.x + e.w - 6, e.y + e.d - 6]
  ])
    P(t, d, p, 2.4, 2.4, 0, c, { top: r.metalDark, south: r.metal, east: r.metalDark, edge: r.metalEdge });
  P(t, e.x, e.y, e.w, e.d, c, c + 3, {
    top: x(r.metalLight, "#d8a86a", 0.25),
    south: r.metal,
    east: r.metalDark,
    edge: r.metalEdge
  });
  const i = 0.5 + (t.reduced ? 0 : Math.sin(t.time * 2e-3) * 0.2);
  for (let d = 0; d < 4; d += 1) {
    const p = e.y + 6 + d * ((e.d - 12) / 3);
    k(n, t.project(e.x + 5, p, c + 3.2), t.project(e.x + e.w - 5, p, c + 3.2), h(o, i), Math.max(1, 1.5 * t.scale));
  }
  const l = t.project(e.x + e.w / 2, e.y + e.d / 2, c + 4);
  wt(n, l, Math.max(4, e.w * 0.3 * t.scale), h(o, 0.22), 0.3);
}
function tn(t, a, e, s, o) {
  const n = t.ctx, r = t.theme, c = 46, i = e.x + e.w / 2;
  for (const p of [e.y + 5, e.y + e.d - 5])
    P(t, i - 2, p - 2, 4, 4, 0, c, { top: r.metalDark, south: r.metal, east: r.metalDark, edge: r.metalEdge });
  P(t, i - 5, e.y + 2, 10, e.d - 4, c, c + 4, {
    top: x(r.metalLight, "#c9b28a", 0.3),
    south: r.metal,
    east: r.metalDark,
    edge: r.metalEdge
  });
  const l = t.reduced ? 0.85 : 0.78 + Math.sin(t.time * 3e-3 + T(a.id, 3) * 4) * 0.12;
  for (let p = 0; p < 4; p += 1) {
    const u = e.y + 8 + p * ((e.d - 16) / 3), m = t.project(i, u, c - 0.4), g = t.project(i, u + 1.5, c - 0.4);
    k(n, m, g, h(o, l), Math.max(1.6, 2.2 * t.scale));
  }
  const d = t.project(i, e.y + e.d / 2, c - 2);
  en(t, d, [
    t.project(e.x - 6, e.y + e.d / 2, 0),
    t.project(e.x + e.w + 6, e.y + e.d / 2, 0)
  ], o, l * 0.2), Ye(t, i, e.y + e.d / 2, Math.max(e.w, e.d) * 0.8, o, 0.16);
}
function en(t, a, e, s, o) {
  const n = t.ctx, r = n.createLinearGradient(a.x, a.y, (e[0].x + e[1].x) / 2, (e[0].y + e[1].y) / 2);
  r.addColorStop(0, h(s, o)), r.addColorStop(1, "rgba(255,255,255,0)"), b(n, [a, e[0], e[1]], r);
}
function an(t, a, e, s, o) {
  const n = t.ctx, r = t.theme, c = e.x + e.w / 2, i = e.y + e.d / 2;
  k(n, t.project(c, e.y + 2, 8), t.project(c, e.y + e.d - 2, 8), h(r.metalDark, 0.85), Math.max(1.6, 2.4 * t.scale)), k(n, t.project(c, e.y + 2, 8), t.project(c, e.y + e.d - 2, 8), h(o, 0.35), Math.max(0.8, 1 * t.scale)), bt(t, c, i, e.w * 0.2, 4, 12, {
    side: r.metalLight,
    sideDark: r.metal,
    top: r.metalLight,
    edge: r.metalEdge
  });
  const l = t.project(c, i + e.w * 0.16, 14), d = t.reduced ? 0.2 : t.time * 8e-4;
  n.beginPath(), n.ellipse(l.x, l.y, Math.max(2, e.w * 0.22 * t.scale), Math.max(1.2, e.w * 0.11 * t.scale), 0, 0, f), n.strokeStyle = h(o, 0.9), n.lineWidth = 1.2, n.stroke();
  for (let p = 0; p < 4; p += 1) {
    const u = d + p / 4 * f;
    k(n, l, {
      x: l.x + Math.cos(u) * e.w * 0.22 * t.scale,
      y: l.y + Math.sin(u) * e.w * 0.11 * t.scale
    }, h(o, 0.8), 0.7);
  }
  ye(t, t.project(c + e.w * 0.3, i, 10), Math.max(1.6, 2.4 * t.scale), 0.4, o);
}
function sn(t, a, e, s, o) {
  const n = t.ctx, r = t.theme, c = e.x + e.w / 2, i = e.y + e.d / 2;
  for (let p = 0; p < 3; p += 1) {
    const u = p / 3 * f + 0.5;
    k(n, t.project(c, i, 0), t.project(c + Math.cos(u) * e.w * 0.4, i + Math.sin(u) * e.d * 0.4, 0), r.metalDark, 1);
  }
  bt(t, c, i, e.w * 0.08, 0, e.h * 0.55, {
    side: r.metalLight,
    sideDark: r.metal,
    top: r.metalLight,
    edge: r.metalEdge
  });
  const l = t.project(c, i, e.h * 0.55 + 14);
  P(t, c - 3, i - 3, 6, 6, e.h * 0.55 + 6, e.h * 0.55 + 14, {
    top: r.metalLight,
    south: r.metal,
    east: r.metalDark,
    edge: r.metalEdge
  }), Pt(t, { x: l.x, y: l.y + 2 }, o, T(a.id, 4), 0.7);
  const d = [
    t.project(c + 5, i - 4, e.h * 0.55 + 10),
    t.project(c + 12, i - 4, e.h * 0.55 + 10),
    t.project(c + 12, i + 2, e.h * 0.55 + 10),
    t.project(c + 5, i + 2, e.h * 0.55 + 10)
  ];
  b(n, d, t.dark ? "#1d3a4a" : "#2f5d74"), K(n, d, h("#9fd8e8", 0.5), 0.6);
}
function on(t, a, e, s, o) {
  const n = t.ctx;
  Yt(t, e, s, 0, e.h), ca(t, X(t, e.x, e.x + e.w, e.y + e.d, 0, e.h), h(t.theme.deviceEdge, 0.4), 3);
  for (let i = 0; i < 3; i += 1) {
    const l = e.h * (0.25 + i * 0.12);
    k(n, t.project(e.x + e.w * 0.16, e.y + e.d + 0.3, l), t.project(e.x + e.w * 0.5, e.y + e.d + 0.3, l), h(t.theme.metalEdge, 0.5), 0.8);
  }
  const r = X(t, e.x + e.w * 0.62, e.x + e.w * 0.94, e.y + e.d, e.h * 0.3, e.h * 0.36);
  b(n, r, h(o, 0.7));
  const c = X(t, e.x + e.w * 0.62, e.x + e.w * 0.94, e.y + e.d, e.h * 0.5, e.h * 0.8);
  Ut(t, c, { variant: "bars", color: o, phase: T(a.id, 8) });
}
const Ja = 62, Qa = 96, nn = 8, kt = 4.5, Ae = 3.2, Da = { light: "#ffcf94", dark: "#ffae63" }, rn = {
  healthy: "green",
  stressed: "amber",
  lost: "red",
  pending: "gray"
};
function za(t) {
  return 44 + Math.round(T(t.id, 5) * 6);
}
function cn(t, a) {
  const e = a.linkedId ?? a.id;
  return t.snapshot.crops.find((s) => s.id === e);
}
function ln(t, a) {
  if (t) return t.status;
  const e = Ba(a.status);
  return e === "red" ? "lost" : e === "amber" ? "stressed" : e === "gray" ? "pending" : "healthy";
}
function dn(t, a) {
  return a === "stressed" ? {
    leaf: x(t.leaf, "#cdb446", 0.6),
    leafLight: x(t.leafLight, "#d8c65c", 0.55),
    leafDark: x(t.leafDark, "#8f7f30", 0.5),
    stem: x(t.stem, "#9a8a45", 0.55),
    fruit: x(t.fruit, "#b99a45", 0.5),
    height: 0.82,
    droop: 1,
    sparse: 0.08,
    fruits: !1
  } : a === "lost" ? {
    leaf: x(t.leafDark, "#7a6247", 0.8),
    leafLight: x(t.leafDark, "#8f7550", 0.66),
    leafDark: x(t.leafDark, "#5b4832", 0.78),
    stem: x(t.soilLight, "#7c6648", 0.5),
    fruit: t.soilLight,
    height: 0.42,
    droop: 1.2,
    sparse: 0.44,
    fruits: !1
  } : a === "pending" ? {
    leaf: x(t.leafLight, "#a7c98b", 0.42),
    leafLight: x(t.leafLight, "#c8e0ae", 0.5),
    leafDark: x(t.leaf, "#8cae74", 0.42),
    stem: t.stem,
    fruit: t.fruit,
    height: 0.46,
    droop: 0.12,
    sparse: 0.04,
    fruits: !1
  } : {
    leaf: t.leaf,
    leafLight: t.leafLight,
    leafDark: t.leafDark,
    stem: t.stem,
    fruit: t.fruit,
    height: 1,
    droop: 0.18,
    sparse: 0,
    fruits: !0
  };
}
function hn(t, a) {
  const e = a ? a.label || a.batch : t.name.replace(/\s+/g, " ");
  return e ? e.length > 6 ? `${e.slice(0, 5)}…` : e : "";
}
function pn(t, a, e, s, o, n, r) {
  const c = t.ctx, i = (o - 0.5) * e * 0.72 * n.droop, l = a.x + s + i, d = a.y - e * (1 - 0.32 * n.droop);
  c.beginPath(), c.moveTo(a.x, a.y), c.quadraticCurveTo(a.x + s * 0.45 + i * 0.25, a.y - e * 0.58, l, d), c.strokeStyle = n.stem, c.lineWidth = Math.max(0.5, e * 0.07), c.stroke();
  const p = e > 8 ? 4 : 3;
  for (let u = 0; u < p; u += 1) {
    const m = 0.26 + u / Math.max(1, p - 1) * 0.68, g = a.x + (l - a.x) * m, y = a.y + (d - a.y) * m, w = u % 2 === 0 ? -1 : 1, v = e * (0.32 + (1 - m) * 0.14), M = e * 0.14;
    c.beginPath(), c.ellipse(g + w * v * 0.76, y, v, M, w * (0.42 + n.droop * 0.5), 0, f), c.fillStyle = u === p - 1 ? n.leafLight : u === 0 ? n.leafDark : n.leaf, c.fill();
  }
  if (r > 0) {
    const u = Math.max(0.6, e * 0.1);
    c.fillStyle = n.fruit;
    for (let m = 0; m < r; m += 1)
      c.beginPath(), c.arc(l + (m === 0 ? -e * 0.14 : e * 0.14), d + e * (0.22 + m * 0.1), u, 0, f), c.fill();
  }
}
function mn(t, a) {
  const e = t.ctx, s = t.theme, o = a.x, n = a.y, r = a.z ?? 0, c = a.w ?? Ja, i = a.d ?? Qa, l = a.h ?? nn, d = r + l, p = za(a), u = cn(t, a), m = ln(u, a), g = Rt(s, rn[m]), y = dn(s, m), w = T(a.id, 3) * f, v = `${a.id}:${u?.id ?? "none"}`, M = t.scale < 0.55, j = t.scale >= 0.55, S = t.scale >= 1.1;
  ae(t, o + 1, n + 1, c, i, 0.9), P(
    t,
    o,
    n,
    c,
    i,
    r,
    d,
    {
      top: s.metalLight,
      south: s.metal,
      east: x(s.metal, s.metalDark, 0.55),
      edge: s.metalEdge,
      highlight: h("#fffaf0", s.dark ? 0.12 : 0.35)
    },
    !0
  );
  const D = o + kt, W = n + kt, N = c - kt * 2, L = i - kt * 2;
  Me(t, D, W, N, L, d - 0.45, x(s.soil, "#000000", 0.3));
  const A = D + 1, q = W + 1, E = N - 2, H = L - 2;
  Me(t, A, q, E, H, d - 1.5, s.soil, h(s.soilLight, 0.5), 0.7);
  const J = _(Math.round(c / 20), 2, 4), z = _(Math.round(i / 15), 4, 7), R = M ? Math.min(2, J) : J, O = M ? Math.min(3, z) : z;
  if (j)
    for (let st = 0; st < O; st += 1) {
      const Q = q + H * ((st + 0.5) / O);
      ke(t, A + 1.5, Q, d - 1.4, A + E - 1.5, Q, d - 1.4, h(s.soilLight, 0.3), 0.7);
    }
  if (u && j) {
    const st = d - l * 0.72, Q = d - l * 0.28;
    b(e, X(t, o + kt, o + c - kt, n + i, st, Q), h(s.waterDark, 0.3));
    const lt = _(u.moisture / 100, 0.06, 1);
    b(
      e,
      X(t, o + kt, o + kt + (c - kt * 2) * lt, n + i, st, Q),
      h(s.water, 0.85)
    );
  }
  if (j) {
    const st = q + H - 2.4;
    ke(t, A + 2, st, d - 0.1, A + E - 2, st, d - 0.1, s.waterDark, Math.max(0.9, 1.2 * t.scale));
    for (let Q = 0; Q < R; Q += 1) {
      const lt = A + 2 + (E - 4) * ((Q + 0.5) / R);
      C(e, t.project(lt, st, d), Math.max(1, 1.1 * t.scale), h(s.waterLight, 0.9));
    }
  }
  if (j) {
    const st = Math.min(7, c * 0.12, i * 0.09), Q = [
      [o + 1.2, n + 1.2],
      [o + c - st - 1.2, n + 1.2],
      [o + 1.2, n + i - st - 1.2],
      [o + c - st - 1.2, n + i - st - 1.2]
    ], lt = {
      top: s.metalLight,
      south: s.metal,
      east: x(s.metal, s.metalDark, 0.6),
      edge: s.metalEdge
    };
    for (const [Et, Lt] of Q)
      P(t, Et, Lt, st, st, d - 1.2, d + 2, lt, !1);
  }
  ke(t, o + 1, n + i, d + 1.6, o + c - 1, n + i, d + 1.6, g, Math.max(1, 1.6 * t.scale)), j && ke(t, o + c, n + 1, d + 1.4, o + c, n + i - 1, d + 1.4, h(g, 0.55), Math.max(0.7, t.scale));
  const Z = Math.min(11, c * 0.2), $ = o + (c - Z) / 2, F = Math.max(3.2, Z * 0.4), Y = o + c / 2 - F / 2, ct = n + 6, yt = n + i - 6 - F, B = {
    top: x(s.metalLight, s.deviceTop, 0.35),
    south: x(s.metal, s.metalDark, 0.2),
    east: s.metalDark,
    edge: s.metalEdge
  };
  P(t, Y, ct, F, F, d, p, B), P(
    t,
    o + c / 2 - 4,
    ct - 1,
    8,
    8,
    p,
    p + 3.4,
    {
      top: x(s.metalDark, g, 0.35),
      south: x(s.metal, g, 0.18),
      east: s.metalDark,
      edge: s.metalEdge
    }
  );
  const pt = t.dark ? Da.dark : Da.light, G = t.reduced ? 0 : Math.sin(t.time * 21e-4 + w) * 0.12 + Math.sin(t.time * 91e-4 + w * 2) * 0.05, ot = _((m === "healthy" ? 0.85 : m === "stressed" ? 0.5 : m === "pending" ? 0.34 : 0.12) + G * (m === "lost" ? 0.4 : 1), 0.05, 1), nt = t.project(o + c / 2, n + i / 2, d + 0.6);
  e.save(), e.translate(nt.x, nt.y), e.scale(1, 0.52), wt(e, { x: 0, y: 0 }, (c + i) * 0.28 * t.scale, h(pt, 0.42 * ot), 0.3), e.restore();
  const Mt = o + kt + Ae, se = n + kt + Ae, It = c - (kt + Ae) * 2, At = i - (kt + Ae) * 2, Dt = (M ? 9 : 13) * t.scale * y.height, St = t.reduced ? 0 : 1.15 * t.scale;
  for (let st = 0; st < O; st += 1)
    for (let Q = 0; Q < R; Q += 1) {
      const lt = st * R + Q;
      if (T(v, 101 + lt) < y.sparse) continue;
      const Et = (Q + 0.5) / R + (T(v, 211 + lt) - 0.5) * (0.22 / R), Lt = (st + 0.5) / O + (T(v, 311 + lt) - 0.5) * (0.22 / O), Ct = Mt + It * _(Et, 0.05, 0.95), ne = se + At * _(Lt, 0.05, 0.95), Gt = t.project(Ct, ne, d - 0.8), Kt = T(v, 401 + lt);
      if (M) {
        const $t = Math.max(1.5, 3.4 * t.scale * y.height);
        e.beginPath(), e.ellipse(Gt.x, Gt.y - $t * 0.4, $t * 1.25, $t * 0.64, 0, 0, f), e.fillStyle = y.leaf, e.fill(), e.beginPath(), e.ellipse(Gt.x - $t * 0.18, Gt.y - $t * 0.78, $t * 0.78, $t * 0.32, 0, 0, f), e.fillStyle = y.leafLight, e.globalAlpha = 0.55, e.fill(), e.globalAlpha = 1;
        continue;
      }
      const be = Math.sin(t.time * 15e-4 + w + lt * 1.7) * St, De = y.fruits && Kt > 0.42 ? Kt > 0.72 ? 2 : 1 : 0;
      pn(t, Gt, Dt * (0.82 + Kt * 0.36), be, Kt, y, De);
    }
  if (j) {
    const st = hn(a, u), Q = Math.min(26, c * 0.42), lt = 2.4, Et = o + c - Q - 6, Lt = n + i - lt - 3.5, Ct = d + 3.6, ne = d + 16;
    if (ke(t, Et + Q / 2, Lt + lt / 2, d, Et + Q / 2, Lt + lt / 2, Ct + 0.4, s.metalDark, 0.9), P(
      t,
      Et,
      Lt,
      Q,
      lt,
      Ct,
      ne,
      {
        top: x(s.metalLight, g, 0.16),
        south: x(s.metal, g, 0.1),
        east: x(s.metal, s.metalDark, 0.55),
        edge: s.metalEdge
      },
      !1
    ), st && t.scale >= 0.72) {
      const Gt = t.project(Et + Q / 2, Lt + lt, (Ct + ne) / 2), Kt = _(Q * 0.866 * t.scale * 0.36, 5, 7.6);
      jt(e, st, Gt.x, Gt.y + 0.4, Kt, s.ink, 650);
    }
  }
  if (!M) {
    const st = t.project(o + kt, n + kt, d), Q = t.project(o + c - kt, n + i - kt, d), lt = t.project(o + c - kt, n + kt, d), Et = t.project(o + kt, n + i - kt, d);
    ea(t, t.project(o + c / 2, n + 6, p - 2.6), st, Q, pt, 0.13 * ot), ea(t, t.project(o + c / 2, n + i - 6, p - 2.6), lt, Et, pt, 0.13 * ot);
  }
  P(t, Y, yt, F, F, d, p, B), P(
    t,
    $,
    n + 4,
    Z,
    i - 8,
    p - 2.6,
    p,
    {
      top: x(s.metal, s.deviceTop, 0.32),
      south: x(s.metal, s.metalDark, 0.55),
      east: x(s.metal, s.metalDark, 0.8),
      edge: s.metalEdge
    }
  );
  const _t = t.project(o + c / 2, n + 7, p - 2.7), Vt = t.project(o + c / 2, n + i - 7, p - 2.7);
  k(e, _t, Vt, h(pt, 0.2 * ot), Math.max(2, 6 * t.scale)), k(e, _t, Vt, h(pt, 0.9 * ot), Math.max(1, 2.4 * t.scale)), M || k(e, _t, Vt, h("#fffaf0", 0.7 * ot), Math.max(0.5, 0.9 * t.scale)), Pt(t, t.project(o + c - 5, n + i - 5, d + 1.2), g, w, S ? 1 : 0.85);
  const Wt = un(t, a), oe = t.selected === a.id, xe = t.hoverId === a.id;
  if (oe || xe) {
    const st = d + 1.8, Q = kt + 1, lt = [
      t.project(o + Q, n + Q, st),
      t.project(o + c - Q, n + Q, st),
      t.project(o + c - Q, n + i - Q, st),
      t.project(o + Q, n + i - Q, st)
    ];
    oe ? (e.save(), K(e, lt, h("#1d1008", 0.22), 3.2), e.setLineDash([7, 5]), e.lineDashOffset = t.reduced ? 0 : -t.time * 0.045, K(e, lt, h(s.accent, 0.95), 1.6), e.restore()) : K(e, lt, h(s.accent, 0.42), 1);
  }
  t.hits.push({
    id: a.id,
    kind: "entity",
    x: Wt.x,
    y: Wt.y,
    w: Wt.w,
    h: Wt.h,
    depth: a.x + a.y + 1
  }), (oe || xe || t.scale > 1.1) && aa(t, a, { x: Wt.x + Wt.w / 2, y: Wt.y - 2 }, { tone: g });
}
function un(t, a) {
  const e = a.z ?? 0, s = a.w ?? Ja, o = a.d ?? Qa, n = e + za(a) + 4, r = [
    t.project(a.x, a.y, e),
    t.project(a.x + s, a.y, e),
    t.project(a.x + s, a.y + o, e),
    t.project(a.x, a.y + o, e),
    t.project(a.x, a.y, n),
    t.project(a.x + s, a.y, n),
    t.project(a.x + s, a.y + o, n),
    t.project(a.x, a.y + o, n)
  ], c = r.map((p) => p.x), i = r.map((p) => p.y), l = Math.min(...c), d = Math.min(...i);
  return {
    x: l,
    y: d,
    w: Math.max(4, Math.max(...c) - l),
    h: Math.max(4, Math.max(...i) - d)
  };
}
const yn = 17, Ea = 11.5, ts = 27.5, es = 1.32, ze = 8.2, Qt = 3.5, fa = [-11.8, 0, 11.8], gn = /* @__PURE__ */ new Set(["transport", "prepare", "assay", "maintenance"]), xn = {
  transport: "#5f9cb4",
  prepare: "#8f77b8",
  assay: "#c1713a",
  maintenance: "#c7862d",
  environment: "#5f8f52"
};
function kn(t) {
  return -0.35 + (T(t, 3) - 0.5) * 0.9;
}
function wn(t) {
  return Array.isArray(t) ? t.filter(
    (a) => a !== null && typeof a == "object" && Number.isFinite(a.x) && Number.isFinite(a.y)
  ) : [];
}
function ia(t) {
  const a = [];
  let e = 0;
  for (let s = 1; s < t.length; s += 1) {
    const o = t[s - 1], n = t[s], r = Math.hypot(n.x - o.x, n.y - o.y);
    a.push(r), e += r;
  }
  return { lengths: a, total: e };
}
function as(t, a) {
  const e = a.x - t.x, s = a.y - t.y;
  return Math.atan2((e + s) * oa, (e - s) * Fa);
}
function Mn(t, a) {
  if (t.length < 2) return t.slice();
  const { lengths: e, total: s } = ia(t);
  if (s <= 0) return [t[0]];
  let o = _(a, 0, 1) * s;
  const n = [t[0]];
  for (let r = 1; r < t.length; r += 1) {
    const c = e[r - 1];
    if (c <= 0) continue;
    if (o >= c) {
      n.push(t[r]), o -= c;
      continue;
    }
    const i = o / c, l = t[r - 1], d = t[r];
    n.push({ x: l.x + (d.x - l.x) * i, y: l.y + (d.y - l.y) * i });
    break;
  }
  return n.length < 2 ? [t[0], t[t.length - 1]] : n;
}
function jn(t, a) {
  if (t.length < 2) return null;
  const { lengths: e, total: s } = ia(t);
  if (s <= 1e-4) return null;
  let o = _(a, 0, 1) * s, n = null;
  for (let r = 0; r < e.length; r += 1) {
    const c = e[r];
    if (!(c <= 1e-4)) {
      if (n = as(t[r], t[r + 1]), o <= c) return n;
      o -= c;
    }
  }
  return n;
}
function vn(t, a, e) {
  let s;
  const o = Array.isArray(a.operations) ? a.operations : [];
  for (const n of o)
    n.robotId !== t || n.status !== "running" || e < n.startTick || e > n.endTick || (!s || n.startTick > s.startTick) && (s = n);
  return s;
}
function ss(t, a, e) {
  const s = kn(t.id), o = vn(t.id, a, e);
  if (!o)
    return { x: t.x, y: t.y, heading: s, moving: !1, progress: 0, operation: void 0 };
  const n = Math.max(1, o.endTick - o.startTick), r = _((e - o.startTick) / n, 0, 1);
  if (o.routeSegments?.length) {
    const p = o.routeSegments;
    let u = p[0].from, m = s, g = !1;
    for (const y of p) {
      if (e < y.startTick) break;
      if (m = as(y.from, y.to), e >= y.endTick) {
        u = y.to;
        continue;
      }
      const w = (e - y.startTick) / Math.max(1, y.endTick - y.startTick);
      u = { x: y.from.x + (y.to.x - y.from.x) * w, y: y.from.y + (y.to.y - y.from.y) * w }, g = !0;
      break;
    }
    return { ...u, heading: m, moving: g, progress: r, operation: o };
  }
  const c = wn(o.route), { total: i } = ia(c);
  if (c.length === 0)
    return { x: t.x, y: t.y, heading: s, moving: !1, progress: r, operation: o };
  if (c.length === 1 || i <= 1e-4) {
    const p = c[c.length - 1];
    return { x: p.x, y: p.y, heading: s, moving: !1, progress: r, operation: o };
  }
  const l = Mn(c, r), d = l[l.length - 1] ?? c[0];
  return {
    x: d.x,
    y: d.y,
    heading: jn(c, r) ?? s,
    moving: r > 0 && r < 1,
    progress: r,
    operation: o
  };
}
function Sn(t, a) {
  const e = ss(a, t.snapshot, t.tick), s = Math.max(1e-3, t.scale * es), o = t.project(e.x, e.y, 0), n = Math.abs(Math.cos(e.heading)), r = Math.abs(Math.sin(e.heading)), c = yn + 6.5, i = (c * n + Ea * r) * s, l = (c * r + Ea * n) * s, d = ts * s;
  return {
    x: o.x - i - 3,
    y: o.y - l - d - 3,
    w: Math.max(12, i * 2 + 6),
    h: Math.max(12, l * 2 + d + 6)
  };
}
function La(t) {
  const a = t.name.split(" ")[0] ?? t.id;
  return a.startsWith("R") ? a : t.id.replace("robot-", "R");
}
function Tn(t, a) {
  return t.length > a ? `${t.slice(0, a - 1)}…` : t;
}
function bn(t, a) {
  return xn[a] ?? t.accent;
}
function Dn(t, a) {
  const e = t.ctx, s = t.theme, o = ss(a, t.snapshot, t.tick), n = Math.max(1e-3, t.scale * es), r = o.heading, c = Math.cos(r), i = Math.sin(r), l = t.project(o.x, o.y, 0), d = me(t, a), p = a.id, u = n >= 0.42, m = n >= 0.95, g = n >= 0.16, y = o.moving && !t.reduced ? Math.sin(t.time * 85e-4 + T(p, 9) * f) * 0.5 * n : 0, w = (I, U, dt = 0) => ({
    x: l.x + (I * c - U * i) * n,
    y: l.y + (I * i + U * c) * n - dt * n - y
  }), v = (I) => Math.max(0.04, I / n), M = x(s.robotBody, d, 0.14), j = x(M, s.robotDark, 0.44), S = x(s.robotDark, "#241b14", 0.58), D = x(M, s.robotLight, 0.2), W = x(s.robotEdge, "#1b120c", 0.4), N = x("#2b2521", s.robotDark, 0.16), L = x(s.robotLight, "#fff6e8", 0.2), A = x(s.robotDark, "#171310", 0.35), q = x(s.metal, s.robotDark, 0.42), E = x(q, "#231b15", 0.28), H = x(q, "#fff2df", 0.4), J = s.dark ? "#b48a37" : "#d8a847", z = s.dark ? "#dbb85c" : "#f4d489", R = s.dark ? "#6b511f" : "#96701f", O = h("#1a130d", t.dark ? 0.5 : 0.22), Z = t.selected === a.id || t.followId === a.id, $ = t.hoverId === a.id;
  if (Z || $) {
    const I = t.reduced ? 0 : Math.sin(t.time * 32e-4) * 1.2, U = (19.5 + (Z ? 2.5 : 0)) * n + I, dt = U * 0.5, vt = { x: l.x, y: l.y + 2 * n };
    ya(e, vt, U, dt, h(d, Z ? 0.55 : 0.26), Z ? 1.3 : 0.9), Z && ya(e, vt, U * 1.26, dt * 1.26, h(d, 0.18), 0.8, [3, 5]);
  }
  if (Bt(
    e,
    { x: l.x + 1.4 * n, y: l.y + 1.7 * n },
    Math.max(4, 19 * n),
    Math.max(2.4, 9.4 * n),
    s.shadow
  ), Bt(
    e,
    { x: l.x + 0.6 * n, y: l.y + 1.1 * n },
    Math.max(2.4, 12 * n),
    Math.max(1.4, 6 * n),
    h("#000000", t.dark ? 0.18 : 0.07)
  ), o.moving && !t.reduced && n >= 0.22) {
    e.save();
    for (let I = 0; I < 6; I += 1) {
      const U = (t.time * 42e-5 + T(p, 40 + I)) % 1, dt = (T(p, 60 + I) - 0.5) * 15, vt = (9 + U * 46) * n, rt = dt * n * (0.4 + U * 0.8), Xt = (1.1 + U * 3.6) * n;
      Xt < 0.5 || (e.globalAlpha = (1 - U) * (t.dark ? 0.16 : 0.3), C(
        e,
        {
          x: l.x - c * vt - i * rt,
          y: l.y - i * vt + c * rt - U * 3.6 * n
        },
        Xt,
        s.dust
      ));
    }
    e.globalAlpha = 1, e.restore();
  }
  if ((t.dark || o.moving) && g) {
    const I = w(12.9, 0, 6.6), U = 46 * n, dt = U * 0.2;
    ea(
      t,
      I,
      { x: I.x + c * U - i * dt, y: I.y + i * U + c * dt },
      { x: I.x + c * U + i * dt, y: I.y + i * U - c * dt },
      t.dark ? "#ffd8a4" : "#ffe8c2",
      t.dark ? 0.2 : 0.05
    );
  }
  const Y = (I) => {
    e.save(), e.translate(l.x, l.y - I * n - y), e.rotate(r), e.scale(n, n);
  }, ct = (I, U, dt, vt, rt, Xt, Le, Ht, Ot, Jt = 1.1) => {
    Ot && (Y(I - Jt), ht(e, U, dt, vt, rt, Xt, Ot), e.restore()), Y(I), Tt(e, U, dt, vt, rt, Xt), e.fillStyle = Le, e.fill(), Ht && (e.strokeStyle = Ht, e.lineWidth = v(0.9), e.stroke()), e.restore();
  }, yt = (I, U, dt) => {
    if (e.save(), e.translate(I, U), e.scale(1, 0.78), e.beginPath(), e.arc(0, 0, Qt, 0, f), e.fillStyle = N, e.fill(), e.strokeStyle = h("#000000", t.dark ? 0.55 : 0.4), e.lineWidth = v(0.9), e.stroke(), e.beginPath(), e.arc(0, 0, Qt * 0.63, 0, f), e.fillStyle = A, e.fill(), u) {
      e.save(), e.rotate(dt), e.strokeStyle = L, e.lineWidth = v(0.85), e.lineCap = "round";
      for (let vt = 0; vt < 5; vt += 1) {
        const rt = vt / 5 * f;
        e.beginPath(), e.moveTo(Math.cos(rt) * Qt * 0.16, Math.sin(rt) * Qt * 0.16), e.lineTo(Math.cos(rt) * Qt * 0.92, Math.sin(rt) * Qt * 0.92), e.stroke();
      }
      e.restore();
    }
    e.beginPath(), e.arc(0, 0, Qt * 0.2, 0, f), e.fillStyle = L, e.fill(), e.beginPath(), e.arc(0, 0, Qt * 0.85, Math.PI * 1.02, Math.PI * 1.62), e.strokeStyle = h("#fff8ec", t.dark ? 0.28 : 0.55), e.lineWidth = v(0.95), e.stroke(), e.restore();
  }, B = (I, U) => {
    const dt = I * (ze - 0.5), vt = [
      w(-11.8, dt, 3.6),
      w(-5.6, I * 6.4, 5.4),
      w(0, I * 6.8, 6),
      w(6, I * 6.4, 5.4),
      w(11.8, dt, 3.6)
    ];
    e.save(), e.lineCap = "round", e.lineJoin = "round", e.beginPath(), vt.forEach((rt, Xt) => Xt === 0 ? e.moveTo(rt.x, rt.y) : e.lineTo(rt.x, rt.y)), e.strokeStyle = h("#000000", t.dark ? 0.5 : 0.3), e.lineWidth = Math.max(1.4, 2.4 * n), e.stroke(), e.strokeStyle = U ? E : x(E, "#000000", 0.3), e.lineWidth = Math.max(0.9, 1.6 * n), e.stroke(), e.strokeStyle = h("#fff3e2", t.dark ? 0.18 : 0.34), e.lineWidth = Math.max(0.5, 0.5 * n), e.stroke();
    for (const rt of vt)
      C(e, { x: rt.x, y: rt.y - 0.25 * n }, Math.max(0.85, 1.05 * n), x(q, "#ffffff", 0.28));
    e.restore();
  }, G = o.progress * 44 + (o.moving && !t.reduced ? t.time * 32e-4 : 0);
  Y(1.8);
  for (const I of fa) yt(I, -ze, G);
  e.restore(), B(-1, !1), ct(2.6, -12, -5.6, 24, 11.2, 2.6, S, null, x(S, "#0e0a07", 0.45), 1.2), ct(4.9, -12.6, -6, 25.2, 12, 2.8, x(j, "#1a130e", 0.3), null, x(j, "#100b08", 0.5), 1.2), Y(8.8), Tt(e, -12.6, -6, 25.2, 12, 2.8);
  const tt = e.createLinearGradient(-12.6, -6, 12.6, 6);
  tt.addColorStop(0, x(j, "#fff6e8", t.dark ? 0.12 : 0.22)), tt.addColorStop(0.52, j), tt.addColorStop(1, x(j, "#241a13", 0.3)), e.fillStyle = tt, e.fill(), e.strokeStyle = W, e.lineWidth = v(0.9), e.stroke(), e.restore(), Y(8.86), k(e, { x: -12.4, y: -3 }, { x: 12.4, y: -3 }, O, v(0.7)), k(e, { x: -7.4, y: 3.1 }, { x: 12.2, y: 3.1 }, O, v(0.7)), k(e, { x: -7.4, y: -6 }, { x: -7.4, y: 6 }, O, v(0.7)), ht(e, -12.2, 4.15, 24.2, 1.35, 0.6, h(d, 0.72)), ht(e, 12, -3.4, 0.9, 6.8, 0.4, h("#140f0b", t.dark ? 0.55 : 0.38));
  for (const I of [-1, 1])
    ht(e, 11.7, I * 5.1 - 0.55, 1.3, 1.1, 0.35, x(q, "#1a130e", 0.42));
  if (u) {
    for (let I = 0; I < 4; I += 1) {
      const U = -11.4 + I * 1.5;
      k(e, { x: U, y: 0.2 }, { x: U, y: 2.3 }, h("#000000", t.dark ? 0.42 : 0.24), v(0.75));
    }
    m && (e.save(), e.translate(7.6, 1.2), e.rotate(Math.PI), jt(e, La(a), 0, 0, 2.9, h("#2a2018", t.dark ? 0.55 : 0.42), 700), e.restore());
  }
  e.restore(), Y(8.92), e.save(), Tt(e, -12.5, -5.9, 4.6, 3.9, 0.9), e.clip(), e.fillStyle = J, e.fillRect(-12.5, -5.9, 4.6, 3.9), u && (e.strokeStyle = z, e.lineWidth = v(0.9), e.beginPath(), e.moveTo(-12.6, -5.4), e.lineTo(-11.2, -4.4), e.lineTo(-12.4, -3.3), e.moveTo(-10.9, -6), e.lineTo(-9.9, -4.8), e.lineTo(-11, -3.9), e.stroke(), e.strokeStyle = R, e.lineWidth = v(0.75), e.beginPath(), e.moveTo(-12.2, -6.1), e.lineTo(-10.8, -5), e.lineTo(-12, -4), e.moveTo(-9.4, -5.7), e.lineTo(-10.4, -4.6), e.stroke()), e.restore(), Tt(e, -12.5, -5.9, 4.6, 3.9, 0.9), e.strokeStyle = R, e.lineWidth = v(0.75), e.stroke(), e.restore(), ct(3.9, 12.7, -5.2, 1.7, 10.4, 0.8, x(j, "#12100e", 0.4), h("#000000", t.dark ? 0.5 : 0.3)), Y(4.05);
  for (let I = 0; I < 4; I += 1) {
    const U = -4.9 + I * 2.55;
    ht(e, 12.8, U, 1.5, 1.5, 0.45, I % 2 === 0 ? s.hazard : x(j, "#000000", 0.42));
  }
  e.restore();
  for (const I of [-1, 1])
    ct(
      7.5,
      12.3,
      I * 3.7 - 1.25,
      2.1,
      2.5,
      0.8,
      x(j, "#0f0c0a", 0.45),
      h("#000000", t.dark ? 0.5 : 0.3)
    );
  if (ct(10.2, -16.4, -4.6, 4.2, 9.2, 1.4, x(j, "#000000", 0.32), null, x(j, "#0d0a08", 0.55), 1.4), ct(13.2, -16.4, -4.6, 4.2, 9.2, 1.4, x(q, "#1c1611", 0.35), W, x(j, "#14100c", 0.4), 1.1), Y(13.3), Tt(e, -15.9, -4.1, 3.3, 8.2, 0.9), e.fillStyle = x(q, "#f6ead8", 0.16), e.fill(), e.strokeStyle = h("#000000", t.dark ? 0.42 : 0.22), e.lineWidth = v(0.7), e.stroke(), u) {
    for (let I = 0; I < 4; I += 1) {
      const U = -3.1 + I * 1.9;
      k(e, { x: -15.6, y: U }, { x: -12.9, y: U }, h("#000000", t.dark ? 0.45 : 0.24), v(0.85));
    }
    ht(e, -16.8, 3.4, 1.3, 1.9, 0.4, s.hazard), k(e, { x: -16.4, y: 3.6 }, { x: -16.7, y: 5.1 }, h("#2a1b0d", 0.75), v(0.8));
  }
  e.restore(), Y(10.4), Tt(e, -10.6, -5.2, 21.2, 10.4, 2.2);
  const ot = e.createLinearGradient(-10.6, -5.2, 8, 5.2);
  ot.addColorStop(0, x(D, "#ffffff", t.dark ? 0.1 : 0.24)), ot.addColorStop(0.6, D), ot.addColorStop(1, x(D, "#3a2c20", 0.16)), e.fillStyle = ot, e.fill(), e.strokeStyle = W, e.lineWidth = v(0.9), e.stroke(), e.beginPath(), e.moveTo(-9.4, -4.4), e.lineTo(-10, -0.4), e.strokeStyle = h("#fffaf0", t.dark ? 0.2 : 0.7), e.lineWidth = v(1), e.stroke(), e.beginPath(), e.moveTo(9.6, 4.4), e.lineTo(10.3, 0.6), e.strokeStyle = h("#241a12", t.dark ? 0.4 : 0.26), e.stroke(), Tt(e, -8.4, -3.9, 16.4, 7.8, 1.8), e.fillStyle = h("#000000", t.dark ? 0.1 : 0.045), e.fill(), e.strokeStyle = h("#fff7ec", t.dark ? 0.16 : 0.46), e.lineWidth = v(0.75), e.stroke();
  for (const I of [-4.2, 0.6, 5])
    k(e, { x: I, y: -3.5 }, { x: I, y: 3.5 }, O, v(0.7));
  if (k(e, { x: -8, y: 0.4 }, { x: 7.8, y: 0.4 }, O, v(0.7)), u)
    for (const [I, U] of [
      [-9.8, -4.5],
      [-5.3, -4.5],
      [0.3, -4.5],
      [5.6, -4.5],
      [9.7, -4.5],
      [-9.8, 4.5],
      [-5.3, 4.5],
      [0.3, 4.5],
      [5.6, 4.5],
      [9.7, 4.5]
    ])
      C(e, { x: I, y: U }, v(0.95), x(D, "#ffffff", 0.7)), C(e, { x: I, y: U + 0.3 }, v(0.55), h("#000000", t.dark ? 0.55 : 0.32));
  ht(e, 2.5, 1.5, 4, 1.9, 0.6, s.screen), Tt(e, 2.5, 1.5, 4, 1.9, 0.6), e.strokeStyle = h(s.screenGlow, 0.5), e.lineWidth = v(0.7), e.stroke(), C(e, { x: 3.1, y: 2.45 }, v(0.7), s.screenGlow), e.restore(), Y(1.8);
  for (const I of fa) yt(I, ze, G);
  e.restore(), B(1, !0);
  const nt = o.operation?.kind, Mt = nt !== void 0 && gn.has(nt) ? 1 : 0, se = t.reduced ? 0.62 : 0.5 + 0.5 * Math.sin(t.time * 16e-4 + T(p, 21) * f), It = Mt * (0.22 + 0.78 * se), At = w(10.8, 3.6, 8.2), Dt = w(12.6 + 5.4 * It, 7.6 - 1.4 * It, 8), St = w(9.2 + 13.4 * It, 9.3 - 4.6 * It, 7 - 0.6 * It), _t = (I, U, dt) => {
    e.save(), e.lineCap = "round", e.lineJoin = "round", e.beginPath(), e.moveTo(At.x, At.y + dt), e.lineTo(Dt.x, Dt.y + dt), e.lineTo(St.x, St.y + dt), e.strokeStyle = I, e.lineWidth = U, e.stroke(), e.restore();
  };
  _t(h("#000000", t.dark ? 0.5 : 0.34), Math.max(1.7, 3.5 * n), 0), _t(E, Math.max(0.95, 2.1 * n), 0), _t(h("#fff3e2", t.dark ? 0.22 : 0.42), Math.max(0.5, 0.7 * n), -0.4 * n), C(e, At, Math.max(1.15, 1.7 * n), A), C(e, At, Math.max(0.45, 0.6 * n), H), C(e, Dt, Math.max(0.95, 1.35 * n), A), m && C(e, Dt, Math.max(0.4, 0.5 * n), H);
  const Vt = Math.atan2(St.y - Dt.y, St.x - Dt.x), Wt = Math.cos(Vt), oe = Math.sin(Vt), xe = -oe, st = Wt, Q = Math.max(1.5, 3 * n), lt = (1.2 + 1.3 * It) * Math.max(0.75, n);
  k(
    e,
    St,
    { x: St.x + Wt * Q + xe * lt, y: St.y + oe * Q + st * lt },
    H,
    Math.max(0.8, 1 * n)
  ), k(
    e,
    St,
    { x: St.x + Wt * Q - xe * lt, y: St.y + oe * Q - st * lt },
    H,
    Math.max(0.8, 1 * n)
  );
  const Et = o.operation ? o.operation.sampleIds.length : 0;
  Et > 0 && (ct(10.4, -13, 0.2, 4.8, 4.6, 1.1, s.sampleDark, null, h(s.sampleDark, 0.92), 1.4), ct(12.6, -12.9, 0.3, 4.6, 4.4, 1, s.sample, h(s.sampleLight, 0.85), s.sampleDark, 1), Y(12.75), u && (k(e, { x: -12.9, y: 2.5 }, { x: -8.4, y: 2.5 }, h("#1b1620", 0.6), v(1.1)), k(e, { x: -10.7, y: 0.5 }, { x: -10.7, y: 4.5 }, h("#1b1620", 0.6), v(1.1)), ht(e, -11.9, 1.8, 2, 1.3, 0.35, s.sampleLight)), e.restore(), ct(12, -7.4, 2.6, 1.7, 2.1, 0.6, s.sampleLight, h(s.sampleDark, 0.7), s.sampleDark, 1.1));
  const Lt = w(-1.4, 0, 10.5), Ct = w(-1.4, 0, 22.2), ne = w(-1.4, 0, 24.4);
  C(e, Lt, Math.max(0.9, 1.4 * n), A), C(e, Lt, Math.max(0.4, 0.6 * n), H), k(e, Lt, Ct, h("#120d09", t.dark ? 0.75 : 0.5), Math.max(1.1, 2 * n)), k(
    e,
    { x: Lt.x - 0.45 * n, y: Lt.y },
    { x: Ct.x - 0.45 * n, y: Ct.y },
    h("#fff6e8", t.dark ? 0.26 : 0.6),
    Math.max(0.45, 0.65 * n)
  );
  const Gt = t.reduced ? 0 : Math.sin(t.time * 52e-5 + T(p, 5) * f) * 0.6 * (o.moving ? 0.3 : 1);
  e.save(), e.translate(Ct.x, Ct.y), e.rotate(r + Gt), e.scale(n, n), ht(e, -3.6, -2.6, 7.2, 5.2, 1.5, x(D, j, 0.35)), Tt(e, -3.6, -2.6, 7.2, 5.2, 1.5), e.strokeStyle = W, e.lineWidth = v(0.85), e.stroke(), ht(e, 1.9, -3.1, 1.4, 6.2, 0.45, j), C(e, { x: 3.3, y: 0 }, 1.6, "#16242a"), C(e, { x: 3.7, y: -0.5 }, 0.55, h("#c6ecff", 0.9)), e.restore(), k(e, Ct, ne, h("#2a221b", 0.5), Math.max(0.45, 0.7 * n)), Pt(t, ne, d, T(p, 7) * f, 0.5);
  const Kt = w(-9, 4, 10.6), be = w(-10.2, 5.2, 23.4);
  k(e, Kt, be, h("#241a12", t.dark ? 0.7 : 0.42), Math.max(0.55, 0.8 * n)), C(e, be, Math.max(0.7, 0.95 * n), H);
  for (const I of [-1, 1]) {
    const U = w(13.1, I * 3.7, 6.9);
    t.dark ? Ya(e, U, Math.max(0.8, 1 * n), "#fff2cc", Math.max(2.4, 5 * n), h("#ffca86", 0.4)) : C(e, U, Math.max(0.55, 0.8 * n), h("#fff6dd", o.moving ? 1 : 0.78));
  }
  const De = Number(a.meta?.battery), $t = Number.isFinite(De), Xe = $t ? _(De / 100, 0, 1) : 1;
  if ($t && u) {
    const I = w(-4.6, -4.3, 10.45);
    e.save(), e.translate(I.x, I.y), e.rotate(r), e.scale(n, n), ht(e, -2.6, -0.55, 5.2, 1.1, 0.55, h("#2a2018", t.dark ? 0.6 : 0.32)), ht(e, -2.5, -0.45, 5 * Xe, 0.9, 0.45, Xe < 0.2 ? s.danger : h(d, 0.95)), e.restore();
  }
  e.globalAlpha = 1;
  const re = o.operation, He = Z || t.followId === a.id || t.hoverId === a.id;
  He || n >= 0.95 || t.camera.zoom >= 1.55;
  const la = re !== void 0 && He && n >= 1.35, da = Et > 0 && t.selected === a.id && n >= 1.45, Oe = _(7.2 + n * 1.3, 7.8, 9), Ee = Math.max(7.1, Oe - 1.1), _e = (I, U, dt, vt, rt = {}) => {
    const Xt = rt.accent ? 9 : 0, Le = rt.battery !== void 0 ? 15 : 0;
    e.font = `650 ${vt}px Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
    const Ht = e.measureText(dt).width + 14 + Xt + Le, Ot = vt + 7, Jt = _(I - Ht / 2, 3, Math.max(3, t.width - Ht - 3)), ie = U - Ot;
    if (ht(e, Jt, ie, Ht, Ot, 4.5, s.labelBg), Tt(e, Jt, ie, Ht, Ot, 4.5), e.strokeStyle = rt.emphasis ? h(s.accent, 0.9) : rt.accent ? h(rt.accent, 0.55) : s.labelEdge, e.lineWidth = rt.emphasis ? 1.2 : 0.8, e.stroke(), rt.accent && C(e, { x: Jt + 6.6, y: ie + Ot / 2 }, 1.9, rt.accent), rt.progress !== void 0 && ht(
      e,
      Jt + 1.6,
      ie + Ot - 2.4,
      Math.max(0, (Ht - 3.2) * _(rt.progress, 0, 1)),
      1.1,
      0.55,
      h(rt.accent ?? d, 0.8)
    ), jt(e, dt, Jt + (Xt + Ht - Le) / 2, ie + Ot / 2 + 0.4, vt, s.label, 650), rt.battery !== void 0) {
      const qe = Jt + Ht - 12, Ze = ie + Ot / 2 - 2, pa = _(rt.battery, 0, 1);
      Tt(e, qe, Ze, 7.5, 4, 1), e.strokeStyle = h(s.label, 0.5), e.lineWidth = 0.7, e.stroke(), ht(e, qe + 0.9, Ze + 0.9, 5.7 * pa, 2.2, 0.5, pa < 0.2 ? s.danger : d), ht(e, qe + 7.7, Ze + 1.2, 1.1, 1.6, 0.4, h(s.label, 0.45));
    }
    return ie;
  };
  let ce = l.y - ts * n - y - 6;
  const ha = Oe + 7 + (la ? Ee + 10 : 0) + (da ? Ee + 10 : 0);
  if (ce - ha < 3 && (ce = 3 + ha), ce = _e(l.x, ce, La(a), Oe, {
    accent: d,
    emphasis: Z,
    battery: $t && He ? Xe : void 0
  }) - 3, la && re && (ce = _e(l.x, ce, Tn(re.title || re.phase || "作业中", 18), Ee, {
    accent: bn(s, re.kind),
    progress: o.progress
  }) - 3), da && re) {
    const I = re.sampleIds[0], U = Et > 1 ? `载荷 ${Et} 件` : `载荷 ${I ?? ""}`.trim();
    _e(l.x, ce, U, Ee, { accent: s.sample });
  }
  const fe = Sn(t, a);
  t.hits.push({
    id: a.id,
    kind: "entity",
    x: fe.x,
    y: fe.y,
    w: fe.w,
    h: fe.h,
    depth: a.x + a.y + 100
  });
}
const Ia = 12, En = 4, zt = 16, he = 10, pe = 15, Pa = {
  failed: 0,
  retest: 1,
  processing: 2,
  fresh: 3,
  stored: 4,
  consumed: 5
};
function Ca(t, a) {
  switch (a) {
    case "failed":
      return Rt(t, "red");
    case "stored":
      return Rt(t, "violet");
    case "processing":
      return Rt(t, "amber");
    case "consumed":
      return Rt(t, "gray");
    case "retest":
      return Rt(t, "blue");
    case "fresh":
    default:
      return Rt(t, "green");
  }
}
function fn(t, a, e, s) {
  const o = t.ctx, n = t.theme, r = a.samples.length;
  if (r === 0) return;
  const c = a.samples[0], i = a.shown, l = a.x + (T(a.key, 1) - 0.5) * 5, d = a.y + (T(a.key, 2) - 0.5) * 5, p = t.project(l, d, pe), u = (zt + he) * 0.5 * 0.87 * t.scale, m = _(8.5 * t.scale, 5.5, 30), g = Math.min(En, r), y = p.y - m - 6, w = {
    top: x(n.screen, n.metalDark, 0.26),
    south: x(n.screen, "#000000", 0.1),
    east: x(n.screen, "#000000", 0.32),
    edge: h(n.metalLight, n.dark ? 0.18 : 0.26)
  };
  if (e || Bt(
    o,
    { x: p.x + 1.5, y: p.y + 2.5 },
    u * 0.92,
    u * 0.34,
    h("#2a1a10", t.dark ? 0.45 : 0.16)
  ), e ? Me(
    t,
    l - zt / 2,
    d - he / 2,
    zt,
    he,
    pe,
    w.top,
    w.edge,
    0.6
  ) : P(t, l - zt / 2, d - he / 2, zt, he, pe - 3.4, pe, w, !1), s) {
    const E = h(n.metalLight, n.dark ? 0.14 : 0.22);
    for (const H of [-1, 1]) {
      const J = d + H * (he / 2 - 2);
      k(
        o,
        t.project(l - zt / 2 + 2, J, pe),
        t.project(l + zt / 2 - 2, J, pe),
        E,
        0.7
      );
    }
  }
  const v = g <= 2 ? g : 2, M = Math.ceil(g / v), j = zt - 5, S = he - 3, D = t.dark ? "rgba(206, 228, 232, 0.34)" : "rgba(248, 253, 255, 0.55)";
  for (let E = 0; E < M; E += 1)
    for (let H = 0; H < v; H += 1) {
      const J = E * v + H;
      if (J >= g) continue;
      const z = i[J], R = l - j / 2 + (H + 0.5) * (j / v), O = d - S / 2 + (E + 0.55) * (S / M), Z = t.project(R, O, pe), $ = Ca(n, z.status);
      if (e) {
        C(o, Z, Math.max(1, 1.7 * t.scale), $);
        continue;
      }
      if (Be(o, Z.x, Z.y, m, $, D), s) {
        const F = Math.max(1.6, m * 0.42);
        k(
          o,
          { x: Z.x - F * 0.3, y: Z.y - m * 0.84 },
          { x: Z.x - F * 0.3, y: Z.y - m * 0.34 },
          h("#ffffff", 0.4),
          0.7
        );
        const Y = t.reduced ? 0.5 : (t.time * 22e-5 + T(a.key, 20 + J)) % 1;
        C(
          o,
          { x: Z.x - F * 0.22, y: Z.y - m * (0.18 + Y * 0.64) },
          Math.max(0.45, m * 0.06),
          h("#ffffff", 0.7)
        );
      }
    }
  if (r > g && t.scale >= 0.55) {
    const E = `+${r - g}`, H = 8 + E.length * 3.8, J = 9.5, z = p.x + u - 3, R = p.y - m - 9;
    je(o, z, R, H, J, n.labelBg, n.labelEdge), jt(o, E, z + H / 2, R + J / 2 + 0.5, 6.6, n.label, 650);
  }
  const W = a.samples.some((E) => E.id === t.selected || E.id === t.hoverId), N = Ca(n, c.status), L = y - (r > g ? 9 : 3);
  if (t.layer === "logistics" && t.scale >= 0.8 || W && t.scale >= 0.5) {
    const E = c.location.label, H = E.length > 9 ? `${E.slice(0, 8)}…` : E;
    t.scale >= 0.9 && k(o, { x: p.x, y: L }, { x: p.x, y: p.y - m * 0.6 }, h(n.muted, 0.35), 0.7), Ka(t, `${r} · ${H}`, { x: p.x, y: L }, { size: 7.6, tone: N });
  } else if (t.layer === "logistics" && t.scale >= 0.5) {
    const E = `${r}`, H = 8 + E.length * 3.6, J = 9, z = p.x - H / 2, R = L - J;
    je(o, z, R, H, J, n.labelBg, h(N, 0.5)), jt(o, E, p.x, R + J / 2 + 0.5, 6.4, n.label, 650);
  }
  const A = Math.max(22, u * 2 + 10), q = Math.max(18, p.y - y + 7);
  t.hits.push({
    id: c.id,
    kind: "sample",
    x: p.x - A / 2,
    y: y - 2,
    w: A,
    h: q,
    depth: c.location.x + c.location.y + 200
  });
}
function Ln(t) {
  const a = t.snapshot.samples;
  if (a.length === 0 || t.scale < 0.18) return;
  const e = t.scale < 0.55, s = t.scale >= 0.75, o = /* @__PURE__ */ new Map();
  for (const r of a) {
    const c = `${Math.round(r.location.x / Ia)}:${Math.round(r.location.y / Ia)}`, i = o.get(c);
    i ? (i.samples.push(r), i.x += r.location.x, i.y += r.location.y) : o.set(c, {
      key: c,
      x: r.location.x,
      y: r.location.y,
      samples: [r],
      shown: []
    });
  }
  const n = Array.from(o.values());
  for (const r of n)
    r.x /= r.samples.length, r.y /= r.samples.length, r.shown = [...r.samples].sort(
      (c, i) => Pa[c.status] - Pa[i.status] || (c.id < i.id ? -1 : c.id > i.id ? 1 : 0)
    );
  n.sort((r, c) => r.x + r.y - (c.x + c.y));
  for (const r of n)
    fn(t, r, e, s);
}
const In = {
  greenhouse: ["reel", "crate", "barrel"],
  water: ["barrel", "cylinder", "crate"],
  prep: ["cylinder", "cart", "bin"],
  analysis: ["cart", "bin", "crate"],
  cold: ["crate", "bin", "cylinder"],
  warehouse: ["pallet", "crate", "barrel"],
  dock: ["crate", "pallet", "cart"],
  maintenance: ["cart", "toolbox", "cylinder"]
}, Pn = {
  crate: [13, 13, 11],
  pallet: [22, 16, 7],
  barrel: [9, 9, 14],
  cylinder: [7, 7, 20],
  cart: [20, 12, 12],
  toolbox: [12, 8, 7],
  bin: [8, 8, 11],
  reel: [12, 12, 9]
};
function Cn(t, a) {
  const e = In[t.kind] ?? ["crate"], s = [
    [t.x + 20, t.y + 26],
    [t.x + t.w - 58, t.y + 26],
    [t.x + 20, t.y + t.h - 48],
    [t.x + t.w - 60, t.y + t.h - 52],
    [t.x + t.w / 2 - 24, t.y + 18]
  ], o = a.filter((i) => i.zoneId === t.id), n = [], r = [], c = s.map((i, l) => ({ point: i, rank: T(t.id, l) })).sort((i, l) => i.rank - l.rank);
  for (const { point: i } of c) {
    if (n.length >= 3) break;
    const [l, d] = i, p = e[n.length % e.length], [u, m, g] = Pn[p];
    r.some(([y, w]) => Math.hypot(y - l, w - d) < 46) || o.some((y) => {
      const w = (y.x ?? 0) + (y.w ?? 30) / 2, v = (y.y ?? 0) + (y.d ?? 30) / 2;
      return Math.hypot(w - (l + u / 2), v - (d + m / 2)) < 42;
    }) || t.door && Math.hypot(t.door.x - l, t.door.y - d) < 50 || (r.push([l, d]), n.push({
      zone: t,
      kind: p,
      x: l,
      y: d,
      w: u,
      d: m,
      h: g,
      seed: `${t.id}-${p}-${n.length}`,
      depth: l + d + 6
    }));
  }
  return n;
}
function An(t, a) {
  const e = t.theme, s = t.ctx, o = a.kind === "crate" || a.kind === "pallet" ? "#b78a52" : a.kind === "cylinder" ? "#7fa3b0" : "#9b8a72", n = x(e.deviceTop, o, 0.34), r = x(e.deviceSide, o, 0.28), c = x(e.deviceFront, o, 0.22), { x: i, y: l, w: d, d: p, h: u } = a;
  switch (ae(t, i, l, d, p, 0.75), a.kind) {
    case "crate": {
      P(t, i, l, d, p, 0, u, { top: n, south: r, east: c, edge: e.deviceEdge });
      for (let m = 1; m < 3; m += 1) {
        const g = u / 3 * m;
        k(s, t.project(i, l + p, g), t.project(i + d, l + p, g), h(e.deviceEdge, 0.5), 0.7);
      }
      k(s, t.project(i + d * 0.5, l + p, 2), t.project(i + d * 0.5, l + p, u - 2), h(e.deviceEdge, 0.5), 0.7);
      break;
    }
    case "pallet": {
      for (let m = 0; m < 3; m += 1)
        P(t, i, l + m * (p / 3), d, p / 4, m * 2, m * 2 + 2.4, {
          top: x(n, "#c79a5f", 0.3),
          south: r,
          east: c,
          edge: e.deviceEdge
        }, !1);
      P(t, i + 2, l + 2, d - 4, p - 4, 5, u, {
        top: x(n, "#d8b47c", 0.3),
        south: x(r, "#b98b52", 0.3),
        east: c,
        edge: e.deviceEdge
      });
      break;
    }
    case "barrel": {
      const m = bt(t, i + d / 2, l + p / 2, d / 2, 0, u, {
        side: x(e.metalLight, o, 0.3),
        sideDark: x(e.metal, o, 0.24),
        top: x(e.metalLight, o, 0.2),
        edge: e.metalEdge
      });
      for (const g of [0.3, 0.7]) {
        const y = t.project(i + d / 2, l + p / 2, u * g);
        s.beginPath(), s.ellipse(y.x, y.y, m.rx, m.ry, 0, 0, Math.PI, !1), s.strokeStyle = h(e.metalDark, 0.55), s.lineWidth = 0.8, s.stroke();
      }
      break;
    }
    case "cylinder": {
      bt(t, i + d / 2, l + p / 2, d / 2, 0, u, {
        side: x(e.metalLight, "#8fb3bf", 0.4),
        sideDark: x(e.metal, "#7b9aa6", 0.35),
        top: e.metalLight,
        edge: e.metalEdge
      });
      const m = t.project(i + d / 2, l + p / 2, u);
      k(s, m, { x: m.x + 2, y: m.y - 4 }, e.metalDark, 1), C(s, { x: m.x + 2, y: m.y - 4 }, 1, e.metalDark);
      break;
    }
    case "cart": {
      P(t, i, l, d, p, u * 0.42, u, { top: n, south: r, east: c, edge: e.deviceEdge });
      for (const [m, g] of [
        [i + 2, l + 1],
        [i + d - 4, l + 1],
        [i + 2, l + p - 3],
        [i + d - 4, l + p - 3]
      ])
        C(s, t.project(m, g, 2), Math.max(0.9, 1.4 * t.scale), e.metalDark);
      k(s, t.project(i + d - 3, l + p - 2, u), t.project(i + d - 3, l + p - 2, u + 10), e.metalDark, 1);
      break;
    }
    case "toolbox": {
      P(t, i, l, d, p, 0, u, { top: n, south: r, east: c, edge: e.deviceEdge }), k(s, t.project(i + d * 0.2, l + p, u - 2), t.project(i + d * 0.8, l + p, u - 2), h(e.metalDark, 0.7), 0.8);
      break;
    }
    case "bin": {
      bt(t, i + d / 2, l + p / 2, d / 2, 0, u, {
        side: x(e.metalLight, "#7d8a72", 0.4),
        sideDark: x(e.metal, "#66735e", 0.35),
        top: e.metalLight,
        edge: e.metalEdge
      });
      break;
    }
    case "reel": {
      const m = t.project(i + d / 2, l + p / 2, u);
      s.beginPath(), s.ellipse(m.x, m.y, d * 0.5 * t.scale, d * 0.26 * t.scale, 0, 0, f), s.strokeStyle = h(e.water, 0.75), s.lineWidth = Math.max(1, 2 * t.scale), s.stroke(), s.beginPath(), s.ellipse(m.x, m.y, d * 0.32 * t.scale, d * 0.17 * t.scale, 0, 0, f), s.strokeStyle = h(e.waterDark, 0.7), s.lineWidth = 0.8, s.stroke(), C(s, m, 1, e.waterDark);
      break;
    }
  }
  (a.kind === "cylinder" || a.kind === "bin") && Pt(t, t.project(i + d, l + p, u * 0.6), e.warning, T(a.seed, 3), 0.6);
}
function Wn(t) {
  const a = t.ctx, e = t.theme;
  for (const s of t.snapshot.operations) {
    if (s.route.length < 2) continue;
    const o = s.status === "running" && t.tick >= s.startTick && t.tick <= s.endTick;
    if (!o && t.layer !== "logistics") continue;
    const n = o ? _((t.tick - s.startTick) / Math.max(1, s.endTick - s.startTick), 0, 1) : 1, r = s.route.map((i) => t.project(i.x, i.y, 2.6));
    a.lineCap = "round", a.lineJoin = "round", a.beginPath(), r.forEach((i, l) => l === 0 ? a.moveTo(i.x, i.y) : a.lineTo(i.x, i.y)), a.setLineDash([5, 8]), a.lineDashOffset = t.reduced ? 0 : -t.time * 0.01, a.strokeStyle = h(e.route, o ? 0.42 : 0.2), a.lineWidth = 1.2, a.stroke(), a.setLineDash([]);
    const c = $n(s.route, n).map((i) => t.project(i.x, i.y, 2.6));
    c.length > 1 && (a.beginPath(), c.forEach((i, l) => l === 0 ? a.moveTo(i.x, i.y) : a.lineTo(i.x, i.y)), a.strokeStyle = h(e.route, 0.9), a.lineWidth = 2, a.stroke());
    for (let i = 0; i < r.length - 1; i += 1) {
      const l = r[i];
      C(a, l, Math.max(0.8, 1.3 * t.scale), h(e.route, 0.5));
    }
    if (c.length > 1) {
      const i = c[Math.floor(c.length / 2)], l = c[Math.min(c.length - 1, Math.floor(c.length / 2) + 1)], d = Math.atan2(l.y - i.y, l.x - i.x), p = Math.max(3, 5 * t.scale);
      a.beginPath(), a.moveTo(i.x + Math.cos(d) * p, i.y + Math.sin(d) * p), a.lineTo(i.x + Math.cos(d + 2.5) * p, i.y + Math.sin(d + 2.5) * p), a.lineTo(i.x + Math.cos(d - 2.5) * p, i.y + Math.sin(d - 2.5) * p), a.closePath(), a.fillStyle = h(e.route, 0.85), a.fill();
    }
    if (o) {
      const i = c[c.length - 1];
      if (i) {
        const l = t.reduced ? 0.5 : t.time * 12e-4 % 1;
        a.beginPath(), a.arc(i.x, i.y, Math.max(2, 3 * t.scale) + l * 6, 0, f), a.strokeStyle = h(e.route, 0.4 * (1 - l)), a.lineWidth = 1, a.stroke(), C(a, i, Math.max(1.4, 2 * t.scale), e.route);
      }
    }
  }
}
function $n(t, a) {
  if (t.length < 2) return t;
  const e = [];
  let s = 0;
  for (let r = 1; r < t.length; r += 1) {
    const c = t[r - 1], i = t[r], l = Math.hypot(i.x - c.x, i.y - c.y);
    e.push(l), s += l;
  }
  let o = s * _(a, 0, 1);
  const n = [t[0]];
  for (let r = 1; r < t.length; r += 1) {
    const c = e[r - 1];
    if (o >= c)
      n.push(t[r]), o -= c;
    else {
      const i = c === 0 ? 0 : o / c, l = t[r - 1], d = t[r];
      n.push({ x: l.x + (d.x - l.x) * i, y: l.y + (d.y - l.y) * i });
      break;
    }
  }
  return n;
}
function Nn(t) {
  if (t.layer !== "risk" && t.layer !== "status") return;
  const a = t.ctx, e = t.theme;
  for (const s of t.snapshot.risks.filter((o) => o.status === "open")) {
    const o = t.snapshot.entities.find((d) => d.id === s.sourceEntityId);
    if (!o) continue;
    const n = s.severity === "critical", r = n ? e.danger : e.warning, c = t.project(o.x + (o.w ?? 40) / 2, o.y + (o.d ?? 40) / 2, (o.h ?? 24) + 22), i = t.reduced ? 0.4 : (t.time * 11e-4 + T(s.id, 2)) % 1;
    a.beginPath(), a.arc(c.x, c.y, Math.max(8, 14 * t.scale) + i * 12, 0, f), a.strokeStyle = h(r, 0.38 * (1 - i)), a.lineWidth = 1.2, a.stroke();
    const l = Math.max(3, 4.5 * t.scale);
    if (a.beginPath(), a.moveTo(c.x, c.y - l), a.lineTo(c.x + l * 0.9, c.y + l * 0.7), a.lineTo(c.x - l * 0.9, c.y + l * 0.7), a.closePath(), a.fillStyle = h(r, 0.95), a.fill(), jt(a, "!", c.x, c.y + l * 0.05, Math.max(4, l * 1.25), "#ffffff", 800), t.scale > 0.82) {
      const d = n ? "风险" : "注意";
      a.font = '650 8.5px Inter, "PingFang SC", system-ui, sans-serif';
      const p = a.measureText(d).width + 12;
      ht(a, c.x - p / 2, c.y - l - 18, p, 13, 4, h(r, 0.92)), jt(a, d, c.x, c.y - l - 11.5, 8.5, "#ffffff", 700);
    }
  }
}
function Rn(t) {
  const a = t.ctx, e = t.theme, s = t.selected;
  if (s) {
    const o = t.snapshot.entities.find((n) => n.id === s);
    if (o) {
      const n = Ne(t, o), r = 5, c = n.x - r, i = n.y - r, l = n.w + r * 2, d = n.h + r * 2, p = t.reduced ? 0.5 : (Math.sin(t.time * 3e-3) + 1) / 2;
      a.save(), a.strokeStyle = h(e.accent, 0.9), a.lineWidth = 1.3, a.setLineDash([7, 5]), a.lineDashOffset = t.reduced ? 0 : -t.time * 0.012, Tt(a, c, i, l, d, 7), a.stroke(), a.setLineDash([]);
      const u = Math.min(10, l / 3, d / 3);
      a.strokeStyle = e.accent, a.lineWidth = 1.8, a.beginPath(), a.moveTo(c, i + u), a.lineTo(c, i), a.lineTo(c + u, i), a.moveTo(c + l - u, i), a.lineTo(c + l, i), a.lineTo(c + l, i + u), a.moveTo(c + l, i + d - u), a.lineTo(c + l, i + d), a.lineTo(c + l - u, i + d), a.moveTo(c + u, i + d), a.lineTo(c, i + d), a.lineTo(c, i + d - u), a.stroke(), a.restore();
      const m = t.project(o.x + (o.w ?? 44) / 2, o.y + (o.d ?? 40) / 2, 0.5);
      a.beginPath(), a.ellipse(m.x, m.y, (n.w * 0.6 + 6) * (1 + p * 0.04), n.h * 0.28 + 3, 0, 0, f), a.strokeStyle = h(e.accent, 0.32), a.lineWidth = 1, a.stroke();
    } else {
      const n = t.snapshot.samples.find((r) => r.id === s);
      if (n) {
        const r = t.project(n.location.x, n.location.y, 12), c = t.reduced ? 0.5 : (Math.sin(t.time * 3e-3) + 1) / 2;
        a.beginPath(), a.arc(r.x, r.y, 9 + c * 3, 0, f), a.strokeStyle = h(e.sample, 0.85), a.lineWidth = 1.2, a.setLineDash([4, 3]), a.stroke(), a.setLineDash([]), wt(a, r, 18, h(e.sample, 0.3), 0.3);
      }
    }
  }
  if (t.hoverId && t.hoverId !== s) {
    const o = t.snapshot.entities.find((n) => n.id === t.hoverId);
    if (o) {
      const n = Ne(t, o);
      Tt(a, n.x - 3, n.y - 3, n.w + 6, n.h + 6, 6), a.strokeStyle = h(e.accent, 0.55), a.lineWidth = 1, a.stroke();
    }
  }
}
function Fn(t) {
  const a = t.ctx, e = t.theme;
  a.textAlign = "center", a.textBaseline = "middle";
  for (const s of t.snapshot.map.zones) {
    const o = Re[s.kind], n = Ua(s), r = t.project(s.x + s.w / 2, s.y, n + 9), c = s.name;
    a.font = '650 8px Inter, "PingFang SC", system-ui, sans-serif';
    const i = a.measureText(c).width + 17, l = 13;
    ht(a, r.x - i / 2, r.y - l / 2, i, l, 4, e.labelBg), Tt(a, r.x - i / 2, r.y - l / 2, i, l, 4), a.strokeStyle = h(o, 0.55), a.lineWidth = 0.8, a.stroke(), C(a, { x: r.x - i / 2 + 5.5, y: r.y }, 1.8, o), jt(a, c, r.x + 3, r.y + 0.4, 8, e.label, 650), t.scale > 1.35 && jt(a, s.short, r.x, r.y + 12, 7.6, e.muted, 500);
  }
}
function Bn(t) {
  const a = t.ctx, e = t.theme, s = t.dark ? 26 : 34;
  for (let o = 0; o < s; o += 1) {
    const n = 6 + T("dust-speed", o) * 16, r = t.reduced ? 0 : (t.time * 4e-6 * n + T("dust-off", o)) % 1 * (t.width + 200) - 100, c = (T("dust-x", o) * t.width + r) % (t.width + 200) - 100, i = T("dust-y", o) * t.height, l = 0.5 + T("dust-r", o) * 1.6, d = (0.12 + T("dust-a", o) * 0.22) * (t.dark ? 0.7 : 1);
    a.globalAlpha = d, C(a, { x: c, y: i }, l, e.dust);
  }
  a.globalAlpha = 1;
}
const sa = 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif', Yn = { healthy: "健康", stressed: "受压", lost: "损失" }, Gn = { idle: "待机", moving: "移动", working: "作业", busy: "忙碌", error: "故障" };
function Xn(t) {
  if (!t.showReadouts) return;
  t.ctx;
  const a = t.snapshot.entities.map((s) => Hn(t, s)).sort((s, o) => s.anchor.y - o.anchor.y || s.anchor.x - o.anchor.x), e = [];
  for (const s of a) {
    const o = qn(s, e, t.width);
    e.push(o), Un(t, s, o);
  }
}
function Hn(t, a) {
  const e = t.ctx, s = Aa(On(a), 20), o = Aa(_n(a), 26);
  e.font = `600 8px ${sa}`;
  const n = e.measureText(s).width;
  e.font = `500 7.5px ${sa}`;
  const r = o ? 4 + e.measureText(o).width : 0;
  return {
    entity: a,
    anchor: t.project(
      a.x + (a.w ?? 40) / 2,
      a.y + (a.d ?? 40) / 2,
      (a.h ?? 20) + 6
    ),
    title: s,
    detail: o,
    tone: Rt(t.theme, a.tone ?? Ba(a.status)),
    w: Math.ceil(9 + n + r + 5),
    h: 15
  };
}
function On(t) {
  return t.kind === "crop" ? String(t.meta?.batch ?? t.id) : t.name;
}
function _n(t) {
  if (t.kind === "crop") {
    const n = Yn[t.status] ?? t.status, r = Number(t.meta?.moisture);
    return Number.isFinite(r) ? `${n} ${r.toFixed(0)}%` : n;
  }
  if (t.kind === "robot") {
    const n = Gn[t.status] ?? t.status, r = Number(t.meta?.battery);
    return Number.isFinite(r) ? `${n} ${r.toFixed(0)}%` : n;
  }
  const a = Number(t.meta?.temperatureReading);
  if (Number.isFinite(a)) {
    const n = Number(t.meta?.chamberCo2);
    return Number.isFinite(n) ? `${a.toFixed(1)}°C · CO₂ ${n.toFixed(0)}` : `${a.toFixed(1)}°C`;
  }
  const e = Number(t.meta?.inlineDoc);
  if (Number.isFinite(e)) return `DOC ${e.toFixed(2)} mg/L`;
  const s = Number(t.meta?.temperature);
  if (Number.isFinite(s)) return `${s.toFixed(1)} °C`;
  const o = Number(t.meta?.powerDraw);
  return Number.isFinite(o) ? `${o} kW` : t.subtitle ?? t.status;
}
function qn(t, a, e) {
  const s = { x: Math.max(3, Math.min(e - t.w - 3, t.anchor.x - t.w / 2)), y: t.anchor.y - t.h - 2, w: t.w, h: t.h }, o = [0, t.h + 3];
  for (let n = 1; n <= 8; n += 1) o.push(-(t.h + 3) * n);
  for (const n of o)
    for (const r of [0, -t.w * 0.55, t.w * 0.55]) {
      const c = {
        ...s,
        x: Math.max(3, Math.min(e - t.w - 3, s.x + r)),
        y: Math.max(3, s.y + n)
      };
      if (!a.some((i) => Zn(c, i))) return c;
    }
  return s;
}
function Zn(t, a) {
  return t.x < a.x + a.w + 2 && t.x + t.w + 2 > a.x && t.y < a.y + a.h + 2 && t.y + t.h + 2 > a.y;
}
function Un(t, a, e) {
  const s = t.ctx, o = t.theme, n = e.x + e.w / 2, r = e.y + e.h;
  (Math.abs(r - a.anchor.y) > 4 || Math.abs(n - a.anchor.x) > 4) && k(s, a.anchor, { x: n, y: r }, h(o.labelEdge, 0.6), 0.7);
  const c = t.selected === a.entity.id;
  je(s, e.x, e.y, e.w, e.h, o.labelBg, c ? o.accent : o.labelEdge), C(s, { x: e.x + 5, y: e.y + e.h / 2 }, 2.2, a.tone);
  const i = e.y + e.h / 2 + 0.5, l = e.x + 9;
  if (jt(s, a.title, l, i, 8, o.label, 600, "left"), a.detail) {
    s.font = `600 8px ${sa}`;
    const d = s.measureText(a.title).width;
    jt(s, `· ${a.detail}`, l + d + 4, i, 7.5, h(o.label, 0.72), 500, "left");
  }
}
function Aa(t, a) {
  return t.length > a ? `${t.slice(0, a - 1)}…` : t;
}
function Wa(t) {
  As(t), Qs(t), Rs(t), go(t);
  for (const e of t.snapshot.map.zones) mo(t, e);
  t.layer === "utilities" && wo(t), Wn(t);
  const a = [];
  for (const e of t.snapshot.map.zones) {
    for (const s of co(e))
      a.push({ depth: s.depth, draw: () => ho(t, s) });
    for (const s of Cn(e, t.snapshot.entities))
      a.push({ depth: s.depth, draw: () => An(t, s) });
  }
  for (const e of t.snapshot.entities)
    e.kind === "crop" ? a.push({ depth: e.x + e.y + 1, draw: () => mn(t, e) }) : e.kind === "robot" ? a.push({ depth: e.x + e.y + 100, draw: () => Dn(t, e) }) : e.kind === "device" && a.push({ depth: e.x + e.y + 4, draw: () => Ao(t, e) });
  a.sort((e, s) => e.depth - s.depth);
  for (const e of a) e.draw();
  Ln(t), Fs(t), Nn(t), Rn(t), Bn(t), $s(t), Ws(t), Fn(t), Xn(t);
}
class Kn {
  constructor(a, e, s) {
    this.canvas = a, this.container = e;
    const o = a.getContext("2d");
    if (!o) throw new Error("Canvas 2D unavailable");
    this.ctx = o, this.onSelect = s.onSelect, this.onBackground = s.onBackground, this.onCamera = s.onCamera, this.tooltips = s.tooltips !== !1, this.hoverLabels = s.hoverLabels !== !1, this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches, this.tooltip = document.createElement("div"), this.tooltip.className = "scene-tooltip", this.tooltip.hidden = !0, e.appendChild(this.tooltip), this.observer = new ResizeObserver(() => this.resize()), this.observer.observe(e), this.resize(), this.bind(), this.frame = requestAnimationFrame(this.loop);
  }
  ctx;
  width = 0;
  height = 0;
  dpr = 1;
  snapshot = null;
  viewTick = 0;
  zoom = 1;
  pan = { x: 0, y: 0 };
  fit = 1;
  selected = null;
  layer = "status";
  followId = null;
  hover = null;
  hits = [];
  pointer = { x: 0, y: 0, down: !1, dragging: !1, startX: 0, startY: 0, panX: 0, panY: 0 };
  frame = 0;
  observer;
  tooltip;
  reduced = !1;
  readouts = !1;
  tooltips = !0;
  hoverLabels = !0;
  onSelect;
  onBackground;
  onCamera;
  destroyed = !1;
  exporting = !1;
  destroy() {
    this.destroyed = !0, cancelAnimationFrame(this.frame), this.observer.disconnect(), this.tooltip.remove(), this.unbind();
  }
  setState(a, e, s, o, n) {
    const r = this.snapshot?.run.id !== a.run.id;
    this.snapshot = a, this.viewTick = e, this.selected = s, this.layer = o, this.followId = n, r && (this.zoom = 1, this.pan = { x: 0, y: 0 }, this.computeFit());
  }
  setViewTick(a) {
    this.viewTick = a;
  }
  setSelected(a) {
    this.selected = a;
  }
  setLayer(a) {
    this.layer = a, this.refreshTooltip();
  }
  /** Toggle the all-entity readout pills drawn by the renderer. */
  setReadouts(a) {
    this.readouts = a;
  }
  setFollow(a) {
    this.followId = a;
  }
  fitView() {
    this.zoom = 1, this.pan = { x: 0, y: 0 }, this.followId = null, this.computeFit();
  }
  zoomBy(a) {
    this.zoom = Math.min(3.6, Math.max(0.55, this.zoom * a));
  }
  /** Pause the live loop while an export renders frames off-screen. */
  setExporting(a) {
    this.exporting = a;
  }
  get zoomLabel() {
    return `${Math.round(this.zoom * 100)}%`;
  }
  /**
   * Render one deterministic frame into a detached canvas. This is the seam
   * the video exporter will call once per output frame: pass an explicit
   * `time` (ms) and `tick`, and the same pixels are produced every run.
   */
  capture(a) {
    const e = Math.max(2, Math.round(a.width)), s = Math.max(2, Math.round(a.height)), o = a.dpr ?? 1, n = document.createElement("canvas");
    n.width = Math.round(e * o), n.height = Math.round(s * o);
    const r = n.getContext("2d");
    if (!r) throw new Error("Canvas 2D unavailable");
    return this.renderFrameTo(r, { ...a, width: e, height: s, dpr: o }), n;
  }
  /** Render one deterministic frame into an existing context (video export path). */
  renderFrameTo(a, e) {
    const s = this.snapshot;
    if (!s) throw new Error("Scene has no snapshot");
    const o = Math.max(2, Math.round(e.width)), n = Math.max(2, Math.round(e.height)), r = e.dpr ?? 1;
    a.setTransform(r, 0, 0, r, 0, 0);
    const c = {
      panX: e.camera?.panX ?? this.pan.x,
      panY: e.camera?.panY ?? this.pan.y,
      zoom: e.camera?.zoom ?? this.zoom,
      fit: e.camera?.fit ?? this.fit
    }, i = document.documentElement.dataset.theme === "dark", l = {
      ctx: a,
      width: o,
      height: n,
      scale: c.fit * c.zoom,
      camera: c,
      snapshot: s,
      tick: e.tick ?? this.viewTick,
      time: e.time,
      theme: ua(i),
      dark: i,
      layer: e.layer ?? this.layer,
      selected: e.selected ?? this.selected,
      hoverId: e.hoverId ?? null,
      followId: null,
      reduced: this.reduced,
      showReadouts: e.readouts ?? this.readouts,
      project: Ve(s, c, o, n),
      hits: []
    };
    Wa(l);
  }
  /** Fit scale for an arbitrary output size (used by the exporter). */
  fitFor(a, e) {
    const s = this.snapshot;
    if (!s) return 1;
    const o = s.map, r = [
      { x: 0, y: 0, z: 0 },
      { x: o.width, y: 0, z: 0 },
      { x: 0, y: o.height, z: 0 },
      { x: o.width, y: o.height, z: 0 },
      ...Ns
    ].map((m) => ({
      x: (m.x - m.y) * 0.8660254,
      y: (m.x + m.y) * 0.5 - (m.z ?? 0) * 0.62
    })), c = Math.min(...r.map((m) => m.x)), i = Math.max(...r.map((m) => m.x)), l = Math.min(...r.map((m) => m.y)), d = Math.max(...r.map((m) => m.y)), p = a - 34, u = e - 34;
    return Math.min(p / (i - c || 1), u / (d - l || 1), 1.3) * 1.02;
  }
  resize() {
    const a = this.container.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1), this.width = Math.max(320, a.width), this.height = Math.max(240, a.height), this.canvas.width = Math.round(this.width * this.dpr), this.canvas.height = Math.round(this.height * this.dpr), this.canvas.style.width = `${this.width}px`, this.canvas.style.height = `${this.height}px`, this.computeFit();
  }
  computeFit() {
    this.fit = this.fitFor(this.width, this.height);
  }
  camera() {
    return { panX: this.pan.x, panY: this.pan.y, zoom: this.zoom, fit: this.fit };
  }
  project(a, e, s = 0) {
    return Ve(this.snapshot, this.camera(), this.width, this.height)(a, e, s);
  }
  loop = (a) => {
    this.destroyed || (!this.exporting && document.visibilityState === "visible" && this.render(this.reduced ? 0 : a), this.frame = requestAnimationFrame(this.loop));
  };
  render(a) {
    const e = this.snapshot;
    if (!e || this.width === 0) return;
    this.applyFollow();
    const s = this.ctx;
    s.setTransform(this.dpr, 0, 0, this.dpr, 0, 0), s.clearRect(0, 0, this.width, this.height);
    const o = document.documentElement.dataset.theme === "dark", n = this.camera();
    this.hits = [];
    const r = {
      ctx: s,
      width: this.width,
      height: this.height,
      scale: n.fit * n.zoom,
      camera: n,
      snapshot: e,
      tick: this.viewTick,
      time: a,
      theme: ua(o),
      dark: o,
      layer: this.layer,
      selected: this.selected,
      hoverId: this.hoverLabels ? this.hover?.id ?? null : null,
      followId: this.followId,
      reduced: this.reduced,
      showReadouts: this.readouts,
      project: Ve(e, n, this.width, this.height),
      hits: this.hits
    };
    Wa(r);
  }
  bind() {
    this.canvas.addEventListener("pointerdown", this.onPointerDown), this.canvas.addEventListener("pointermove", this.onPointerMove), this.canvas.addEventListener("pointerup", this.onPointerUp), this.canvas.addEventListener("pointerleave", this.onPointerLeave), this.canvas.addEventListener("wheel", this.onWheel, { passive: !1 }), this.canvas.addEventListener("dblclick", this.onDoubleClick);
  }
  unbind() {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown), this.canvas.removeEventListener("pointermove", this.onPointerMove), this.canvas.removeEventListener("pointerup", this.onPointerUp), this.canvas.removeEventListener("pointerleave", this.onPointerLeave), this.canvas.removeEventListener("wheel", this.onWheel), this.canvas.removeEventListener("dblclick", this.onDoubleClick);
  }
  localPoint(a) {
    const e = this.canvas.getBoundingClientRect();
    return { x: a.clientX - e.left, y: a.clientY - e.top };
  }
  onPointerDown = (a) => {
    if (a.button !== 0) return;
    const e = this.localPoint(a);
    this.canvas.setPointerCapture(a.pointerId), this.pointer = {
      ...this.pointer,
      down: !0,
      dragging: !1,
      x: e.x,
      y: e.y,
      startX: e.x,
      startY: e.y,
      panX: this.pan.x,
      panY: this.pan.y
    };
  };
  onPointerMove = (a) => {
    const e = this.localPoint(a);
    if (this.pointer.x = e.x, this.pointer.y = e.y, this.pointer.down) {
      const o = e.x - this.pointer.startX, n = e.y - this.pointer.startY;
      !this.pointer.dragging && Math.hypot(o, n) > 4 && (this.pointer.dragging = !0, this.followId = null, this.container.classList.add("is-dragging"), this.onCamera?.()), this.pointer.dragging && (this.pan.x = this.pointer.panX + o, this.pan.y = this.pointer.panY + n, this.tooltip.hidden = !0);
      return;
    }
    const s = this.hitAt(e.x, e.y);
    this.hover = s, this.canvas.style.cursor = s ? "pointer" : "grab", s ? this.showTooltip(s, e.x, e.y) : this.tooltip.hidden = !0;
  };
  onPointerUp = (a) => {
    if (!this.pointer.down) return;
    const e = this.localPoint(a), s = this.pointer.dragging;
    if (this.pointer.down = !1, this.pointer.dragging = !1, this.container.classList.remove("is-dragging"), s) return;
    const o = this.hitAt(e.x, e.y);
    o ? this.onSelect(o.kind, o.id) : this.onBackground();
  };
  onPointerLeave = () => {
    this.hover = null, this.tooltip.hidden = !0;
  };
  refreshTooltip() {
    !this.hover || this.tooltip.hidden || this.showTooltip(this.hover, this.pointer.x, this.pointer.y);
  }
  onWheel = (a) => {
    a.preventDefault();
    const e = this.localPoint(a), s = this.worldAt(e.x, e.y);
    if (this.zoom = Math.min(3.6, Math.max(0.55, this.zoom * Math.exp(-a.deltaY * 12e-4))), s) {
      const o = this.fit * this.zoom, n = this.snapshot.map.width / 2, r = this.snapshot.map.height / 2, c = this.width / 2 + (s.x - n - (s.y - r)) * 0.8660254 * o, i = this.height / 2 + (s.x - n + (s.y - r)) * 0.5 * o - s.z * 0.62 * o;
      this.pan = { x: e.x - c, y: e.y - i };
    }
  };
  onDoubleClick = () => {
    this.fitView(), this.onBackground();
  };
  worldAt(a, e) {
    const s = this.snapshot;
    if (!s) return null;
    const o = this.fit * this.zoom, n = s.map.width / 2, r = s.map.height / 2, c = (a - this.width / 2 - this.pan.x) / (0.8660254 * o), i = (e - this.height / 2 - this.pan.y) / (0.5 * o);
    return {
      x: n + (c + i) / 2,
      y: r + (i - c) / 2,
      z: 0
    };
  }
  hitAt(a, e) {
    for (let s = this.hits.length - 1; s >= 0; s -= 1) {
      const o = this.hits[s];
      if (a >= o.x && a <= o.x + o.w && e >= o.y && e <= o.y + o.h) return o;
    }
    return null;
  }
  showTooltip(a, e, s) {
    if (!this.snapshot) return;
    if (!this.tooltips) {
      this.tooltip.hidden = !0;
      return;
    }
    this.tooltip.innerHTML = this.hitLabel(a), this.tooltip.hidden = !1;
    const n = this.tooltip.offsetWidth, r = this.tooltip.offsetHeight;
    this.tooltip.style.transform = `translate(${Math.min(this.width - n - 12, e + 14)}px, ${Math.max(8, s - r - 12)}px)`;
  }
  hitLabel(a) {
    if (!this.snapshot) return "";
    if (a.kind === "sample") {
      const o = this.snapshot.samples.find((n) => n.id === a.id);
      return o ? `<b>${te(o.id)}</b><span>${te(o.label)}</span><small>${te(o.status)} · ${te(o.location.label)}</small>` : "";
    }
    const e = this.snapshot.entities.find((o) => o.id === a.id);
    if (!e) return "";
    const s = this.operationForEntity(e);
    return `<b>${te(e.name)}</b><span>${te(e.subtitle ?? e.status)}</span>${s ? `<small>${te(s.title)}</small>` : `<small>${te(e.status)}</small>`}`;
  }
  operationForEntity(a) {
    return this.snapshot?.operations.find(
      (e) => (e.robotId === a.id || e.deviceId === a.id) && e.status === "running" && this.viewTick >= e.startTick && this.viewTick <= e.endTick
    );
  }
  focusEntity(a) {
    const e = this.snapshot?.entities.find((d) => d.id === a);
    if (!e || !this.snapshot) return;
    this.followId = null, this.zoom = Math.max(this.zoom, 1.15);
    const s = this.snapshot.operations.find(
      (d) => d.robotId === e.id && d.status === "running" && this.viewTick >= d.startTick && this.viewTick <= d.endTick
    );
    let o = { x: e.x, y: e.y };
    if (s && s.route.length > 1) {
      const d = Math.min(1, Math.max(0, (this.viewTick - s.startTick) / Math.max(1, s.endTick - s.startTick))), p = $a(s.route, d);
      o = p[p.length - 1] ?? o;
    }
    const n = this.fit * this.zoom, r = this.snapshot.map.width / 2, c = this.snapshot.map.height / 2, i = this.width / 2 + (o.x - r - (o.y - c)) * 0.8660254 * n, l = this.height / 2 + (o.x - r + (o.y - c)) * 0.5 * n - (e.h ?? 20) * 0.62 * n;
    this.pan = { x: this.width / 2 - i, y: this.height / 2 - l };
  }
  applyFollow() {
    if (!this.followId || !this.snapshot) return;
    const a = this.snapshot.entities.find((p) => p.id === this.followId && p.kind === "robot");
    if (!a) return;
    const e = this.snapshot.operations.find(
      (p) => p.robotId === a.id && p.status === "running" && this.viewTick >= p.startTick && this.viewTick <= p.endTick
    );
    let s = { x: a.x, y: a.y };
    if (e && e.route.length > 1) {
      const p = Math.min(1, Math.max(0, (this.viewTick - e.startTick) / Math.max(1, e.endTick - e.startTick))), u = $a(e.route, p);
      s = u[u.length - 1] ?? s;
    }
    const o = this.fit * this.zoom, n = this.snapshot.map.width / 2, r = this.snapshot.map.height / 2, c = this.width / 2 + (s.x - n - (s.y - r)) * 0.8660254 * o, i = this.height / 2 + (s.x - n + (s.y - r)) * 0.5 * o - 20 * 0.62 * o, l = this.width / 2 - c, d = this.height / 2 - i;
    this.pan.x += (l - this.pan.x) * 0.14, this.pan.y += (d - this.pan.y) * 0.14;
  }
}
function $a(t, a) {
  if (t.length < 2) return t;
  const e = [];
  let s = 0;
  for (let r = 1; r < t.length; r += 1) {
    const c = t[r - 1], i = t[r], l = Math.hypot(i.x - c.x, i.y - c.y);
    e.push(l), s += l;
  }
  let o = s * Math.min(1, Math.max(0, a));
  const n = [t[0]];
  for (let r = 1; r < t.length; r += 1) {
    const c = e[r - 1];
    if (o >= c)
      n.push(t[r]), o -= c;
    else {
      const i = c === 0 ? 0 : o / c, l = t[r - 1], d = t[r];
      n.push({ x: l.x + (d.x - l.x) * i, y: l.y + (d.y - l.y) * i });
      break;
    }
  }
  return n;
}
function te(t) {
  return t.replace(/[&<>"']/g, (a) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[a]);
}
export {
  Kn as MarsScene,
  ms as mapFoundationSnapshot,
  Vn as mapMarsSnapshot
};
