// ---------------------------------------------------------------------------
// mechanics-graph.js — нодовая схема механик v3 (формат хранения version: 2): типизированный
// ациклический граф, компилятор в план исполнения, декларативное исполнение правил и редактор.
// Загружается сразу после mechanics.js. Произвольный код не исполняется.
// ---------------------------------------------------------------------------
(() => {
  const Base = window.Mechanics;
  if (!Base) throw new Error('mechanics.js должен быть загружен до mechanics-graph.js');
  const Formulas = window.Formulas;
  if (!Formulas) throw new Error('formulas.js должен быть загружен до mechanics-graph.js');
  const NodeForm = window.NodeForm;
  if (!NodeForm) throw new Error('node-params-form.js должен быть загружен до mechanics-graph.js');
  const clone = value => JSON.parse(JSON.stringify(value));
  const GRAPH_VERSION = 2;
  const NodeRegistry = window.NodeRegistry;
  if (!NodeRegistry) throw new Error('node-registry.js должен быть загружен до mechanics-graph.js');
  const { ACTION_KINDS, ROLL_KINDS, COMPUTED, VALUE_TYPES, ABILITIES, NODE_DEFS } = NodeRegistry;
  // Определение узла: тип — закрытое имя реестра.
  const defOf = type => NodeRegistry.nodeDef(type);
  const nodeLabel = (type, params = null) => (defOf(type) ? NodeRegistry.nodeTitle(type, params) : type);
  const mkId = prefix => `${prefix}-${(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)}`;
  const actionType = type => type.startsWith('action.') && (ACTION_KINDS.includes(type.slice(7)));
  // Вид блока плана для узла действия (реестр знает про kind броска, kind поля и spend → consume).
  const blockKind = (type, p) => NodeRegistry.blockKindOf(type, p);
  // «Изменить поле» хранит параметры всех трёх видов; в блок плана попадают только поля своего вида.
  const fieldBlockParams = (type, params) => NodeRegistry.blockParamsOf(type, params);
  // Новые узлы: характеристики и навыки, кости, сравнение и логика. Одинаковы в клиенте и в движке сервера (src/mechanics_graph.rs).
  // Значение узла по значениям входов: get(socket) отдаёт значение входа или undefined. Неизвестное — undefined.
  function computedValue(type, p, get) {
    const def = NodeRegistry.nodeDef(type);
    if (def && typeof def.compute === 'function') return def.compute(p, get);
    return undefined;
  }
  // Условие контекста (редакция/уровень/подкласс/выбор) считается по снимку листа, а не по входам.
  function contextConditionValue(p, context) {
    const def = NodeRegistry.nodeDef('condition.context');
    return def && typeof def.evaluate === 'function' ? def.evaluate(p, context) : undefined;
  }

  function graphOf(mechanics) { return mechanics?.graph || { nodes: [], links: [], frames: [], groups: [] }; }
  function graphEnvelope(graph, metadata = {}) {
    return { ...metadata, version: GRAPH_VERSION, graph: {
      nodes: Array.isArray(graph?.nodes) ? graph.nodes : [], links: Array.isArray(graph?.links) ? graph.links : [],
      frames: Array.isArray(graph?.frames) ? graph.frames : [], groups: Array.isArray(graph?.groups) ? graph.groups : [],
    } };
  }
  // Поле when у действия (hit/miss) переносится в узлы: condition.hit → flow.if → выход «да»/«нет».
  // Меняет граф на месте; семантика та же (гейт только на сам узел). Без входа в цепочку поле не переносится.
  function liftWhenGates(graph) {
    let changed = false;
    for (const node of [...graph.nodes]) {
      if (!actionType(node.type)) continue;
      const when = node.params?.when;
      if (when !== 'hit' && when !== 'miss') continue;
      const index = graph.links.findIndex(l => l.to.node === node.id && l.to.socket === 'exec');
      if (index < 0) continue;
      const pos = node.position || { x: 0, y: 0 };
      const hit = { id: mkId('node'), type: 'condition.hit', params: {}, position: { x: pos.x, y: pos.y + 130 } };
      const branch = { id: mkId('node'), type: 'flow.if', params: {}, position: { x: pos.x, y: pos.y } };
      node.position = { x: pos.x + 260, y: pos.y };
      node.params = { ...node.params, when: 'always' };
      graph.links[index] = { from: clone(graph.links[index].from), to: { node: branch.id, socket: 'exec' } };
      graph.links.push({ from: { node: hit.id, socket: 'value' }, to: { node: branch.id, socket: 'condition' } });
      graph.links.push({ from: { node: branch.id, socket: when === 'hit' ? 'then' : 'else' }, to: { node: node.id, socket: 'exec' } });
      graph.nodes.push(hit, branch);
      changed = true;
    }
    return changed;
  }
  // Ветвление по попаданию действует на ветвь; вложенное ветвление по попаданию внутри такой ветви не поддерживается.
  function gatedHitNesting(nodes, links) {
    const types = new Map(nodes.map(n => [n.id, n.type]));
    const branchTargets = (id, sockets) => links.filter(l => l.from.node === id && sockets.includes(l.from.socket)).map(l => l.to.node);
    const hitFlows = new Set(nodes.filter(n => n.type === 'flow.if' && links.some(l => l.to.node === n.id && l.to.socket === 'condition' && types.get(l.from.node) === 'condition.hit')).map(n => n.id));
    for (const id of hitFlows) {
      const stack = branchTargets(id, ['then', 'else']), seen = new Set();
      while (stack.length) {
        const current = stack.pop(); if (seen.has(current)) continue; seen.add(current);
        if (hitFlows.has(current)) return true;
        if (types.get(current) === 'flow.if') stack.push(...branchTargets(current, ['then', 'else']));
      }
    }
    return false;
  }
  function expandGroups(graph, groupsById = new Map(), prefix = '') {
    const boundaryTypes = new Set(['group.input', 'group.output']);
    function buildContext(value, nodePrefix, ownerInstance, stack) {
      const ctx = { nodes: value.nodes || [], links: value.links || [], prefix: nodePrefix, owner: ownerInstance, children: new Map() };
      for (const node of ctx.nodes) {
        if (node.type !== 'group.instance') continue;
        const groupId = String(node.params?.group_id || ''), group = groupsById.get(groupId);
        if (!group || stack.has(groupId)) continue;
        const nextStack = new Set(stack); nextStack.add(groupId);
        ctx.children.set(node.id, buildContext(group, `${nodePrefix}${node.id}/`, node.id, nextStack));
      }
      return ctx;
    }
    const root = buildContext(graph, prefix, null, new Set());
    const nodes = [], links = [];
    function resolveSource(path, nodeId, socket, depth = 0) {
      if (depth > 100) return [];
      const ctx = path[path.length - 1], node = ctx.nodes.find(item => item.id === nodeId);
      if (!node) return [];
      if (node.type === 'group.input') {
        if (path.length < 2) return [];
        const parent = path[path.length - 2], socketId = String(node.params?.socket_id || ''), instanceId = ctx.owner;
        const outer = parent.links.find(link => link.to.node === instanceId && link.to.socket === socketId);
        return outer ? resolveSource(path.slice(0, -1), outer.from.node, outer.from.socket, depth + 1) : [];
      }
      if (node.type === 'group.instance') {
        const child = ctx.children.get(node.id); if (!child) return [];
        const output = child.nodes.find(item => item.type === 'group.output' && item.params?.socket_id === socket);
        if (!output) return [];
        const inner = child.links.find(link => link.to.node === output.id && link.to.socket === 'value');
        return inner ? resolveSource([...path, child], inner.from.node, inner.from.socket, depth + 1) : [];
      }
      if (boundaryTypes.has(node.type)) return [];
      return [{ node: `${ctx.prefix}${node.id}`, socket }];
    }
    function resolveTarget(path, nodeId, socket, depth = 0) {
      if (depth > 100) return [];
      const ctx = path[path.length - 1], node = ctx.nodes.find(item => item.id === nodeId);
      if (!node) return [];
      if (node.type === 'group.output') {
        if (path.length < 2) return [];
        const parent = path[path.length - 2], socketId = String(node.params?.socket_id || ''), instanceId = ctx.owner;
        const outer = parent.links.find(link => link.from.node === instanceId && link.from.socket === socketId);
        return outer ? resolveTarget(path.slice(0, -1), outer.to.node, outer.to.socket, depth + 1) : [];
      }
      if (node.type === 'group.instance') {
        const child = ctx.children.get(node.id); if (!child) return [];
        const input = child.nodes.find(item => item.type === 'group.input' && item.params?.socket_id === socket);
        if (!input) return [];
        const inner = child.links.filter(link => link.from.node === input.id && link.from.socket === 'value');
        return inner.flatMap(link => resolveTarget([...path, child], link.to.node, link.to.socket, depth + 1));
      }
      if (boundaryTypes.has(node.type)) return [];
      return [{ node: `${ctx.prefix}${node.id}`, socket }];
    }
    function collect(ctx, path) {
      for (const node of ctx.nodes) {
        if (node.type === 'group.instance') { const child = ctx.children.get(node.id); if (child) collect(child, [...path, child]); continue; }
        // Развёрнутые узлы групп сохраняют свои канонические типы: исполнение и компиляция видят их напрямую.
        if (!boundaryTypes.has(node.type)) nodes.push({ ...clone(node), id: `${ctx.prefix}${node.id}` });
      }
      for (const link of ctx.links) {
        const fromNode = ctx.nodes.find(node => node.id === link.from.node), toNode = ctx.nodes.find(node => node.id === link.to.node);
        if (boundaryTypes.has(fromNode?.type) || boundaryTypes.has(toNode?.type)) continue;
        const sources = resolveSource(path, link.from.node, link.from.socket);
        const targets = resolveTarget(path, link.to.node, link.to.socket);
        for (const from of sources) for (const to of targets) links.push({ from, to });
      }
    }
    collect(root, [root]);
    return { nodes, links };
  }
  function v2ToV1(mechanics, context = {}) {
    if (!mechanics || mechanics.version !== GRAPH_VERSION) return clone(mechanics);
    const groups = new Map((mechanics.graph?.groups || []).map(g => [g.id, g]));
    const expanded = expandGroups(graphOf(mechanics), groups), byId = new Map(expanded.nodes.map(node => [node.id, node]));
    const outgoing = new Map(), incoming = new Map();
    for (const link of expanded.links) {
      const key = `${link.from.node}:${link.from.socket}`;
      if (!outgoing.has(key)) outgoing.set(key, []);
      outgoing.get(key).push(link.to.node);
      incoming.set(`${link.to.node}:${link.to.socket}`, link.from);
    }
    function outputValue(endpoint) {
      const node = byId.get(endpoint?.node); if (!node) return undefined;
      const p = node.params || {};
      if (COMPUTED.has(node.type)) return computedValue(node.type, p, socket => inputValue(node, socket, undefined));
      if (node.type.startsWith('data.')) return clone(p.value);
      if (node.type === 'condition.context') return contextConditionValue(p, context);
      return undefined;
    }
    function inputValue(node, socket, fallback) {
      const source = incoming.get(`${node.id}:${socket}`);
      return source ? outputValue(source) : fallback;
    }
    const programs = [];
    for (const n of expanded.nodes.filter(node => node.type === 'action.program')) {
      const params = n.params || {}, programId = String(params.program_id || n.id);
      const p = { id: programId, name: String(params.name || 'Действие'), trigger: params.trigger === 'passive' ? 'passive' : 'use', ...(params.style && params.style !== 'default' ? { style: String(params.style) } : {}), blocks: [] };
      for (const key of ['feature_name', 'group', 'roll_only']) if (params[key] !== undefined) p[key] = clone(params[key]);
      // Очередь хранит [узел, гейт]. Гейт «hit»/«miss» ставит ветка «Если» по условию «Попадание атаки»
      // и действует только на узел, подключённый к выходу ветки. Продолжение цепочки — без гейта.
      const pending = [...(outgoing.get(`${n.id}:exec`) || [])].reverse().map(id => [id, null]), visited = new Set();
      while (pending.length) {
        const [nodeId, gate] = pending.pop(); if (visited.has(nodeId)) continue; visited.add(nodeId);
        const node = byId.get(nodeId); if (!node) continue;
        if (node.type === 'flow.if') {
          const source = incoming.get(`${node.id}:condition`), hitGate = byId.get(source?.node)?.type === 'condition.hit';
          const condition = hitGate ? undefined : inputValue(node, 'condition', undefined);
          const sockets = condition === undefined ? ['else', 'then'] : [condition ? 'then' : 'else'];
          for (const socket of sockets) {
            const branch = hitGate ? (socket === 'then' ? 'hit' : 'miss') : gate;
            for (const target of [...(outgoing.get(`${node.id}:${socket}`) || [])].reverse()) pending.push([target, branch]);
          }
          continue;
        }
        if (!actionType(node.type)) continue;
        const params = clone(node.params || {}), kind = blockKind(node.type, params), blockId = params.block_id || node.id;
        const ap = fieldBlockParams(node.type, params);
        if (gate && (ap.when === undefined || ap.when === 'always')) ap.when = gate;
        // Кость, поданная проводом на вход «Кость», заменяет поле dice блока.
        const diceIn = inputValue(node, 'dice', undefined); if (diceIn !== undefined) ap.dice = diceIn;
        const enabled = inputValue(node, 'enabled', ap.enabled);
        // Динамическое условие блока проверяется после enabled: false пропускает блок,
        // а поток идёт дальше по exec — как у выключенного блока.
        let skip = enabled === false;
        if (!skip && inputValue(node, 'condition', undefined) === false) skip = true;
        if (!skip) {
          if (enabled !== undefined) ap.enabled = enabled;
          delete ap.block_id; delete ap.enabled_input; delete ap.kind;
          p.blocks.push({ ...ap, id: blockId, kind });
        }
        for (const target of [...(outgoing.get(`${node.id}:exec`) || [])].reverse()) pending.push([target, null]);
      }
      programs.push(p);
    }
    const out = { version: 1, programs };
    for (const key of ['origin', 'item_defaults']) if (mechanics[key] !== undefined) out[key] = clone(mechanics[key]);
    return out;
  }

  function interfaceSockets(group) {
    const names = xs => Object.fromEntries((xs || []).map(x => [x.id, x.type]));
    return { inputs: names(group.inputs), outputs: names(group.outputs) };
  }
  function socketMap(node, groups, ownerGroup = null) {
    if (node.type === 'group.instance') {
      const group = groups.get(String(node.params?.group_id || ''));
      return group ? interfaceSockets(group) : { inputs: {}, outputs: {} };
    }
    if (node.type === 'group.input' || node.type === 'group.output') {
      const socketId = String(node.params?.socket_id || ''), direction = node.type === 'group.input' ? 'inputs' : 'outputs';
      const item = ownerGroup?.[direction]?.find(x => x.id === socketId);
      if (!item) return { inputs: {}, outputs: {} };
      return node.type === 'group.input' ? { inputs: {}, outputs: { value: item.type } } : { inputs: { value: item.type }, outputs: {} };
    }
    const def = defOf(node.type);
    return def ? { inputs: def.inputs, outputs: def.outputs } : { inputs: {}, outputs: {} };
  }
  // Поток исполнения: сокеты типа flow (exec у действий, then/else у «Если», flow-порты групп).
  // Правило «начало → конец»: каждое действие идёт от «Начала» (action.program) до «Конца» (flow.end),
  // и каждая ветвь «Если» тоже завершается «Концом». Это смысловые проблемы (запись сохраняется,
  // граф не исполняется), а не структурные ошибки схемы.
  const FLOW_END_UNWIRED = '«Конец» ни к чему не подключён';
  const FLOW_BRANCH_UNFINISHED = 'Ветка не завершается узлом «Конец»';
  const flowActionUnfinished = name => `Действие «${name}» не завершается узлом «Конец»`;
  function flowPorts(node, groups, ownerGroup) {
    const map = socketMap(node, groups, ownerGroup);
    return {
      outputs: Object.entries(map.outputs || {}).filter(([, type]) => type === 'flow').map(([socket]) => socket),
      inputs: new Set(Object.entries(map.inputs || {}).filter(([, type]) => type === 'flow').map(([socket]) => socket)),
    };
  }
  // Связи потока: только провода между flow-выходом и flow-входом (остальные проверяет validateGraph).
  function flowLinks(nodes, links, groups, ownerGroup) {
    const byId = new Map(nodes.map(node => [node.id, node])), ports = new Map(), outgoing = new Map(), incoming = new Map();
    for (const node of nodes) ports.set(node.id, flowPorts(node, groups, ownerGroup));
    for (const link of links) {
      const source = link?.from, target = link?.to;
      if (!source || !target || !byId.has(source.node) || !byId.has(target.node)) continue;
      if (!(ports.get(source.node)?.outputs || []).includes(source.socket)) continue;
      if (!ports.get(target.node)?.inputs.has(target.socket)) continue;
      const key = `${source.node}:${source.socket}`;
      if (!outgoing.has(key)) outgoing.set(key, []);
      outgoing.get(key).push(target.node);
      incoming.set(target.node, (incoming.get(target.node) || 0) + 1);
    }
    return { byId, ports, outgoing, incoming };
  }
  // Проверка завершённости: у каждого action.program поток (включая обе ветви flow.if) должен
  // доходить до flow.end, а «Конец» без входящего потока — проблема.
  function addFlowProblems(nodes, links, groups, ownerGroup, problems) {
    const { byId, ports, outgoing, incoming } = flowLinks(nodes, links, groups, ownerGroup);
    const reported = new Set(), report = message => { if (!reported.has(message)) { reported.add(message); problems.push(message); } };
    const visiting = new Set(), finished = new Set();
    // true — все продолжения потока этого узла заканчиваются «Концом»; у «Если» проверяются обе ветви.
    function terminates(id, inBranch, actionName) {
      if (visiting.has(id) || finished.has(id)) return true;
      const node = byId.get(id);
      if (!node || node.type === 'flow.end') { finished.add(id); return true; }
      const branchNode = node.type === 'flow.if', outputs = ports.get(id)?.outputs || [];
      visiting.add(id);
      let ok = true;
      if (!outputs.length) { ok = false; report(inBranch ? FLOW_BRANCH_UNFINISHED : flowActionUnfinished(actionName)); }
      for (const socket of outputs) {
        const targets = outgoing.get(`${id}:${socket}`) || [];
        if (!targets.length) { ok = false; report(branchNode || inBranch ? FLOW_BRANCH_UNFINISHED : flowActionUnfinished(actionName)); continue; }
        for (const target of targets) if (!terminates(target, inBranch || branchNode, actionName)) ok = false;
      }
      visiting.delete(id);
      if (ok) finished.add(id);
      return ok;
    }
    for (const node of nodes) {
      if (node.type === 'flow.end') { if (!incoming.get(node.id)) report(FLOW_END_UNWIRED); continue; }
      if (node.type !== 'action.program') continue;
      const name = String(node.params?.name || node.params?.program_id || node.id);
      let started = false;
      for (const socket of ports.get(node.id)?.outputs || []) for (const target of outgoing.get(`${node.id}:${socket}`) || []) { started = true; terminates(target, false, name); }
      if (!started) report(flowActionUnfinished(name));
    }
  }
  // Обход потока одного действия от «Начала»: порядок узлов, висячие exec-выходы и достигнутые «Концы».
  function flowReach(graph, program) {
    const nodes = graph.nodes || [], links = graph.links || [], groups = new Map((graph.groups || []).map(group => [group.id, group]));
    const { byId, ports, outgoing } = flowLinks(nodes, links, groups, null);
    const order = [], dangling = [], ends = [], seen = new Set([program.id]), queue = [program.id];
    while (queue.length) {
      const id = queue.shift(), node = byId.get(id);
      if (!node) continue;
      if (node.type === 'flow.end') { ends.push(id); continue; }
      const index = order.push(id) - 1;
      for (const socket of ports.get(id)?.outputs || []) {
        const targets = outgoing.get(`${id}:${socket}`) || [];
        if (!targets.length) { dangling.push({ node: id, socket, index }); continue; }
        for (const target of targets) if (!seen.has(target)) { seen.add(target); queue.push(target); }
      }
    }
    return { order, dangling, ends };
  }
  // Достраивает «Конец» действию с оборванным потоком: висячие exec-выходы подключаются к «Концу»
  // действия, а если его ещё нет — создаётся узел. Граф меняется на месте; повторный вызов ничего не меняет.
  function addFlowEnds(graph) {
    const nodes = graph.nodes || [], links = graph.links || [];
    let added = 0;
    for (const program of nodes.filter(node => node.type === 'action.program')) {
      const flow = flowReach(graph, program);
      if (!flow.dangling.length) continue;
      const owned = nodes.find(node => node.type === 'flow.end' && node.action === program.id);
      let end = (flow.ends.length && nodes.find(node => node.id === flow.ends[0])) || owned || null;
      if (!end) {
        const anchor = nodes.find(node => node.id === flow.dangling[flow.dangling.length - 1].node) || program;
        end = { id: mkId('node'), type: 'flow.end', params: {}, position: { x: (anchor.position?.x || 0) + 260, y: anchor.position?.y || 0 }, action: program.id };
        nodes.push(end); added++;
      }
      for (const item of flow.dangling) {
        if (links.some(link => link.from.node === item.node && link.from.socket === item.socket && link.to.node === end.id)) continue;
        links.push({ from: { node: item.node, socket: item.socket }, to: { node: end.id, socket: 'exec' } });
        added++;
      }
    }
    return added;
  }
  const fail = message => message;
  const idText = (value, max = 80) => typeof value === 'string' && value.length > 0 && value.length <= max;
  // Программы графа: на них ссылается источник data.result (last — отдельный вариант).
  function programIds(nodes) {
    const ids = new Set();
    for (const node of nodes || []) if (node?.type === 'action.program') ids.add(String(node.params?.program_id || node.id || ''));
    return ids;
  }
  function allProgramIds(graph, groups = []) {
    const ids = programIds(graph?.nodes);
    for (const group of groups || []) for (const id of programIds(group?.nodes)) ids.add(id);
    return ids;
  }
  function validateInterface(list) {
    if (!Array.isArray(list) || list.length > 16) return 'Интерфейс группы: не более 16 сокетов.';
    const ids = new Set();
    for (const socket of list) {
      if (!socket || !idText(socket.id, 64) || ids.has(socket.id) || typeof socket.name !== 'string' || !socket.name.trim() || socket.name.length > 100 || !VALUE_TYPES.includes(socket.type)) return 'Некорректный типизированный сокет группы.';
      ids.add(socket.id);
    }
    return '';
  }
  // Смысловые проблемы связей (сокеты, типы, цикл, незавершённость) собираются в список problems:
  // сохранение их не блокирует, исполнение пропускает граф. Без списка функция работает строго (первая ошибка).
  function soft(problems, message) { if (!problems) return fail(message); problems.push(message); return ''; }
  function validateGraph(graph, groups = [], nested = false, ownerGroup = null, problems = null, options = {}) {
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return fail('Граф должен быть объектом.');
    const nodes = graph.nodes, links = graph.links, frames = graph.frames || [];
    if (!nested && !Array.isArray(groups)) return fail('Не более 50 групп повторного использования.');
    const graphGroups = Array.isArray(groups) ? groups : [];
    if (!Array.isArray(nodes) || nodes.length > 500 || !Array.isArray(links) || links.length > 2000 || !Array.isArray(frames) || frames.length > 100) return fail('Размер графа вне допустимых пределов.');
    const groupMap = new Map(graphGroups.map(g => [g.id, g]));
    if (!nested) {
      if (!Array.isArray(groups) || groups.length > 50) return fail('Не более 50 групп повторного использования.');
      for (const g of groups) {
        if (!g || !idText(g.id, 64) || typeof g.name !== 'string' || !g.name.trim() || g.name.length > 120) return fail('Некорректная группа повторного использования.');
        const a = validateInterface(g.inputs), b = validateInterface(g.outputs);
        if (a || b) return a || b;
        if (!Array.isArray(g.nodes) || !Array.isArray(g.links)) return fail('У группы должны быть свои nodes и links.');
      }
      if (new Set(groups.map(g => g.id)).size !== groups.length) return fail('Повторяющийся ID группы.');
    }
    // Программы — для ссылки data.result: верхний вызов передаёт набор всего графа (с группами).
    const programs = options.programs || programIds(nodes);
    const nodeIds = new Set();
    for (const node of nodes) {
      if (!node || !idText(node.id, 100) || nodeIds.has(node.id) || !defOf(node.type)) return fail('Неизвестный узел или повторяющийся ID.');
      nodeIds.add(node.id);
      if (node.params !== undefined && (!node.params || typeof node.params !== 'object' || Array.isArray(node.params) || JSON.stringify(node.params).length > 100000)) return fail('Параметры узла должны быть ограниченным JSON-объектом.');
      if (node.position !== undefined && (!node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) || Math.abs(node.position.x) > 100000 || Math.abs(node.position.y) > 100000)) return fail('Координаты узла вне допустимых пределов.');
      if (node.type === 'group.instance' && !groupMap.has(String(node.params?.group_id || ''))) return fail('Узел ссылается на отсутствующую группу.');
      if (['group.input', 'group.output'].includes(node.type) && (!nested || !ownerGroup)) return fail('Узлы интерфейса группы разрешены только внутри повторно используемой группы.');
      const paramsError = validateNodeParams(node, programs);
      if (paramsError) return paramsError;
    }
    const incoming = new Set(), adjacency = new Map([...nodeIds].map(id => [id, []])), indegree = new Map([...nodeIds].map(id => [id, 0]));
    const linkKeys = new Set();
    for (const link of links) {
      const source = link?.from, target = link?.to;
      if (!source || !target || !nodeIds.has(source.node) || !nodeIds.has(target.node)) { const e = soft(problems, 'Провод указывает на отсутствующий узел.'); if (e) return e; continue; }
      const fromNode = nodes.find(n => n.id === source.node), toNode = nodes.find(n => n.id === target.node);
      const fromSockets = socketMap(fromNode, groupMap, ownerGroup).outputs, toSockets = socketMap(toNode, groupMap, ownerGroup).inputs;
      if (!Object.hasOwn(fromSockets, source.socket) || !Object.hasOwn(toSockets, target.socket)) { const e = soft(problems, 'Провод подключён к отсутствующему сокету.'); if (e) return e; continue; }
      if (fromSockets[source.socket] !== toSockets[target.socket]) { const e = soft(problems, 'Типы сокетов провода не совпадают.'); if (e) return e; continue; }
      if (fromNode.type === 'condition.hit' && !(toNode.type === 'flow.if' && target.socket === 'condition')) { const e = soft(problems, 'Условие попадания подключается только ко входу «Если».'); if (e) return e; continue; }
      const targetKey = `${target.node}:${target.socket}`, manyInputs = toNode.type === 'flow.end';
      if (!manyInputs && incoming.has(targetKey)) { const e = soft(problems, 'К каждому входному сокету подключается только один провод.'); if (e) return e; continue; }
      if (!manyInputs) incoming.add(targetKey);
      const linkKey = `${source.node}:${source.socket}>${target.node}:${target.socket}`;
      if (linkKeys.has(linkKey)) { const e = soft(problems, 'Повторяющийся провод.'); if (e) return e; continue; }
      linkKeys.add(linkKey);
      adjacency.get(source.node).push(target.node); indegree.set(target.node, indegree.get(target.node) + 1);
    }
    for (const node of nodes) if (node.type === 'flow.if' && !incoming.has(`${node.id}:condition`)) { const e = soft(problems, 'Условному узлу требуется типизированное логическое условие.'); if (e) return e; }
    const queue = [...nodeIds].filter(id => indegree.get(id) === 0); let visited = 0;
    while (queue.length) { const current = queue.pop(); visited++; for (const target of adjacency.get(current)) { indegree.set(target, indegree.get(target) - 1); if (indegree.get(target) === 0) queue.push(target); } }
    if (visited !== nodeIds.size) { const e = soft(problems, 'Цикл в графе запрещён.'); if (e) return e; }
    if (gatedHitNesting(nodes, links.filter(l => nodeIds.has(l.from?.node) && nodeIds.has(l.to?.node)))) { const e = soft(problems, 'Ветвление по попаданию нельзя вкладывать в другое ветвление по попаданию.'); if (e) return e; }
    // Завершённость потока («Начало → Конец») — смысловая проблема, а не структурная: связь можно
    // провести, запись сохранить; connectionError эту проверку пропускает (options.completion).
    if (options.completion !== false) {
      const unfinished = [];
      addFlowProblems(nodes, links, groupMap, ownerGroup, unfinished);
      for (const message of unfinished) { const e = soft(problems, message); if (e) return e; }
    }
    const frameIds = new Set(), framedNodes = new Set();
    for (const frame of frames) {
      if (!frame || !idText(frame.id, 64) || frameIds.has(frame.id) || typeof frame.title !== 'string' || !frame.title.trim() || frame.title.length > 120 || !Array.isArray(frame.nodes) || frame.nodes.length > 100) return fail('Некорректная рамка графа.');
      frameIds.add(frame.id);
      for (const nodeId of frame.nodes) {
        if (!nodeIds.has(nodeId) || framedNodes.has(nodeId)) return fail('Рамка содержит отсутствующий или повторный узел.');
        framedNodes.add(nodeId);
      }
    }
    if (!nested) {
      const refs = new Map(groups.map(g => [g.id, (g.nodes || []).filter(n => n.type === 'group.instance').map(n => String(n.params?.group_id || ''))]));
      const visiting = new Set(), visitedGroups = new Set();
      const walk = id => {
        if (visiting.has(id)) return false;
        if (visitedGroups.has(id)) return true;
        visiting.add(id);
        for (const next of refs.get(id) || []) if (!refs.has(next) || !walk(next)) return false;
        visiting.delete(id); visitedGroups.add(id); return true;
      };
      for (const id of refs.keys()) if (!walk(id)) return fail('Рекурсивная ссылка или цикл между группами запрещён.');
      for (const group of groups) {
        const error = validateGraph({ nodes: group.nodes, links: group.links, frames: group.frames || [] }, groups, true, group, problems, options);
        if (error) return `Группа «${group.name}»: ${error}`;
        const boundaryInputs = (group.nodes || []).filter(n => n.type === 'group.input').map(n => n.params?.socket_id);
        const boundaryOutputs = (group.nodes || []).filter(n => n.type === 'group.output').map(n => n.params?.socket_id);
        for (const sockets of [[group.inputs, boundaryInputs], [group.outputs, boundaryOutputs]]) {
          const expected = sockets[0].map(s => s.id).sort(), actual = sockets[1].slice().sort();
          if (JSON.stringify(expected) !== JSON.stringify(actual)) return fail('Порты группы должны иметь по одному соответствующему узлу входа/выхода.');
        }
      }
    }
    return '';
  }
  function validateNodeParams(node, programs = null) {
    const type = node.type;
    const p = node.params || {};
    const def = NodeRegistry.nodeDef(type);
    if (def && typeof def.validate === 'function') {
      const err = def.validate(p);
      if (err) return err;
    }
    // Источник результата — «последнее действие» или программа этого графа (как на сервере).
    if (type === 'data.result' && programs) {
      const source = String(p.source || '');
      if (source !== 'last' && !programs.has(source)) return 'Результат: выберите последнее действие или программу этого графа.';
    }
    if (actionType(type)) {
      if (!idText(p.block_id, 100)) return 'Узел действия должен иметь стабильный block_id.';
      if (type === 'action.roll' && p.kind !== undefined && !ROLL_KINDS.includes(p.kind)) return 'Настраиваемый бросок: тип roll, attack, damage, heal или temp_hp.';
      const kind = blockKind(type, p);
      if (ROLL_KINDS.includes(kind)) {
        const error = Base.validate({ version: 1, programs: [{ id: 'p', name: 'p', trigger: 'use', blocks: [{ id: 'b', kind, dice: p.dice || { count: 0, sides: 6, bonus: 0 }, enabled: p.enabled, when: p.when }] }] });
        if (error && !p.dice?.advanced) return error;
      }
    }
    return '';
  }
  // Сохранение: блокируют только структурные ошибки (размер, ID, типы узлов, параметры, интерфейс групп).
  // Смысловые проблемы связей сохраняются и показываются списком; исполнение их пропускает (см. problems).
  function validate(mechanics) {
    if (!mechanics || mechanics.version !== GRAPH_VERSION) return 'Неподдерживаемая схема механик.';
    if (!mechanics.graph || !Array.isArray(mechanics.graph.groups)) return 'Не более 50 групп повторного использования.';
    if (JSON.stringify(mechanics).length > 1_000_000) return 'Неподдерживаемая или слишком большая схема механик.';
    const list = [];
    const programs = allProgramIds(mechanics.graph, mechanics.graph.groups);
    // Завершённость потока здесь не проверяется: это смысловая проблема (запись сохраняется), и она
    // не должна отменять проверку плана — иначе незакрытая цепочка скрыла бы ошибки в блоках.
    const error = validateGraph(mechanics.graph, mechanics.graph.groups, false, null, list, { completion: false, programs });
    if (error) return error;
    if (list.length) return '';
    const planError = Base.validate(v2ToV1(mechanics));
    if (planError) return planError;
    const allNodes = [...(mechanics.graph.nodes || []), ...(mechanics.graph.groups || []).flatMap(g => g.nodes || [])];
    for (const n of allNodes) {
      const e = validateNodeParams(n, programs);
      if (e) return e;
    }
    return '';
  }
  // Список проблем графа без сохранения: пустой список значит, что граф можно исполнять.
  // options.completion = false — без проверки завершённости потока (нужно при правке проводов).
  function graphProblems(graph, groups = graph?.groups || [], options = {}) {
    const list = [];
    const error = validateGraph(graph, groups, false, null, list, { ...options, programs: options.programs || allProgramIds(graph, groups) });
    return error ? [error] : list;
  }
  function problems(mechanics) {
    const structural = validate(mechanics);
    if (structural) return [structural];
    const list = graphProblems(mechanics.graph, mechanics.graph.groups);
    if (list.length) return list;
    const planError = Base.validate(v2ToV1(mechanics));
    return planError ? [planError] : [];
  }

  function valueForInput(node, socket, values) {
    const linked = values.linksByTarget.get(`${node.id}:${socket}`);
    if (linked) return values.outputs.get(`${linked.node}:${linked.socket}`);
    return node.params?.[socket] ?? node.params?.value;
  }
  function orderedNodes(graph, groups) {
    const expanded = expandGroups(graph, groups);
    const adjacency = new Map(), indegree = new Map();
    for (const n of expanded.nodes) { adjacency.set(n.id, []); indegree.set(n.id, 0); }
    const linksByTarget = new Map();
    for (const l of expanded.links) {
      adjacency.get(l.from.node)?.push(l.to.node);
      indegree.set(l.to.node, (indegree.get(l.to.node) || 0) + 1);
      linksByTarget.set(`${l.to.node}:${l.to.socket}`, l.from);
    }
    const queue = expanded.nodes.filter(n => !indegree.get(n.id));
    const ordered = [];
    while (queue.length) {
      const n = queue.shift(); ordered.push(n);
      for (const to of adjacency.get(n.id) || []) { indegree.set(to, indegree.get(to) - 1); if (!indegree.get(to)) queue.push(expanded.nodes.find(x => x.id === to)); }
    }
    return { ordered, linksByTarget };
  }
  const valuesOf = value => Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  // Снаряжение из узлов: фиксированный список и варианты выбора. Имя усекается, количество приводится к 1–1000.
  const normalizeEquipmentItems = raw => (Array.isArray(raw) ? raw : []).slice(0, 100)
    .map(item => ({ name: String(item?.name || '').trim().slice(0, 120), qty: Math.max(1, Math.min(1000, Math.trunc(Number(item?.qty) || 1))) }))
    .filter(item => item.name);
  const normalizeEquipmentOptions = raw => (Array.isArray(raw) ? raw : []).slice(0, 50)
    .map((option, index) => ({ name: String(option?.name || `Вариант ${index + 1}`).trim().slice(0, 120), items: normalizeEquipmentItems(option?.items), gold: Math.max(0, Math.min(1000000, Math.trunc(Number(option?.gold) || 0))) }));
  function applyRuleNode(type, p, incoming, sheet, context, outputs) {
    const on = incoming('enabled'); if (on === false) return;
    const def = NodeRegistry.nodeDef(type);
    const n = input => incoming(input);
    const value = input => n(input) ?? p[input] ?? p.value;
    const emit = (kind, data = {}) => context.effects.push({ kind, ...clone(data), source: context.source || '', node_id: context.nodeId });
    const env = { get: n, value, emit, sheet, context, clone, valuesOf, appendProficiency, normalizeEquipmentItems, normalizeEquipmentOptions };
    if (def && typeof def.project === 'function') def.project(p, env);
    outputs.set(`${context.nodeId}:effect`, { type: 'effect', node_type: type });
  }
  function appendProficiency(sheet, label, values) {
    const text = (values || []).map(x => String(x || '').trim()).filter(Boolean).join(', ');
    if (text) sheet.proficiencies += `${label}: ${text}\n`;
  }
  function evaluateGraph(mechanics, options = {}) {
    const blocking = problems(mechanics);
    if (blocking.length) return { error: `Граф не исполняется: ${blocking[0]}`, sheet: null };
    const edition = String(options.edition || '2014');
    const level = Math.max(1, Math.min(20, Math.trunc(Number(options.level) || 1)));
    const sheet = { edition, level, abilities: Object.fromEntries(ABILITIES.map(k => [k, 10])), race: '', class: '', subclass: '', speed: 30, hp: { max: 0, current: 0, temp: 0 },
      features: [], saving_throws: [], skills: [], skill_choices: [], languages: [], proficiencies: '', spells: { ability: '', slots: {}, known: [] }, spell_rules: [], spell_progression: { slots: {} }, asi_rules: [], class_progression: null, class_rules: null, armor_formula: '', manual_rules: [] };
    const { ordered, linksByTarget } = orderedNodes(graphOf(mechanics), new Map((mechanics.graph.groups || []).map(g => [g.id, g])));
    const values = { linksByTarget, outputs: new Map() };
    const context = { edition, level, subclass: options.subclass || '', choices: options.choices || {}, source: options.source || '', nodeId: '', effects: [] };
    const get = (node, socket) => valueForInput(node, socket, values);
    for (const node of ordered) {
      context.nodeId = node.id;
      const p = node.params || {}, type = node.type;
      if (type === 'data.number' || type === 'data.dice') values.outputs.set(`${node.id}:value`, clone(p.value));
      else if (type === 'condition.context') values.outputs.set(`${node.id}:value`, contextConditionValue(p, context));
      else if (COMPUTED.has(type)) values.outputs.set(`${node.id}:value`, computedValue(type, p, socket => get(node, socket)));
      else if (type.startsWith('rule.')) applyRuleNode(type, p, socket => get(node, socket), sheet, context, values.outputs);
    }
    sheet.skills = [...new Set(sheet.skills)];
    return { error: '', sheet, manual_rules: sheet.manual_rules, effects: context.effects, actions: v2ToV1(mechanics, { edition, level, subclass: options.subclass || '', choices: options.choices || {} }).programs || [] };
  }
  function applyGraphRules(mechanics, target, options = {}) {
    // Запись без механик ничего не накладывает: сборка листа зовёт правило для каждой записи.
    if (!mechanics) return { error: '', sheet: target, manual_rules: [], effects: [], actions: [] };
    const result = evaluateGraph(mechanics, options);
    if (result.error) return result;
    target.abilities ||= Object.fromEntries(ABILITIES.map(key => [key, 10]));
    target.saving_throws ||= []; target.skills ||= []; target.languages ||= []; target.features ||= [];
    target.hp ||= { max: 0, current: 0, temp: 0, hit_dice: '1d8' };
    target.spells ||= { slots: {}, known: [] }; target.spells.slots ||= {}; target.proficiencies ||= '';
    target.graph_spell_rules ||= []; target.asi_rules ||= []; target.skill_choices ||= [];
    for (const effect of result.effects) {
      if (effect.kind === 'ability_bonus') target.abilities[effect.ability] = (Number(target.abilities[effect.ability]) || 10) + effect.amount;
      else if (effect.kind === 'speed') target.speed = effect.value;
      else if (effect.kind === 'languages') { target.languages.push(...effect.values); appendProficiency(target, 'Языки', effect.values); }
      else if (effect.kind === 'proficiencies') appendProficiency(target, effect.label, effect.values);
      else if (effect.kind === 'hit_die') target.hp.hit_dice = `1${effect.value}`;
      else if (effect.kind === 'saving_throws') target.saving_throws = [...new Set([...target.saving_throws, ...effect.values])];
      else if (effect.kind === 'feature') target.features.push(effect.feature);
      else if (effect.kind === 'skills') { target.skill_choices.push({ id: effect.id, count: effect.count, options: effect.options, selected: effect.selected }); target.skills.push(...effect.selected); }
      // Владение навыком из графа (например, запись навыка или раса «Острые чувства»).
      else if (effect.kind === 'skill_proficiency') target.skills.push(...(effect.values || []));
      else if (effect.kind === 'spell_list') target.graph_spell_rules.push({ mode: effect.mode, ability: effect.ability, spells: clone(effect.spells), source: effect.source });
      else if (effect.kind === 'spell_slots') target.spells.slots = { ...target.spells.slots, ...clone(effect.table) };
      else if (effect.kind === 'asi') target.asi_rules.push(clone(effect.table));
      else if (effect.kind === 'class_progression') target.class_progression = clone(effect.table);
      else if (effect.kind === 'unarmored_defense') target.unarmored_defense = { formula: effect.formula, name: effect.name, no_shield: effect.no_shield };
      else if (effect.kind === 'hp_bonus') { target.hp.max += effect.amount; target.hp.current += effect.amount; }
      else if (effect.kind === 'manual') (target.manual_rules ||= []).push(effect.text);
      else if (effect.kind === 'equipment') (target.equipment_grants ||= []).push(...clone(effect.items || []));
      else if (effect.kind === 'equipment_choice') (target.equipment_choices ||= []).push(clone(effect));
      else if (effect.kind === 'class_features') target.class_features = clone(effect.table);
      else if (effect.kind === 'spellcasting') target.spells.ability = effect.ability;
    }
    target.skills = [...new Set(target.skills)];
    return { error: '', target, effects: result.effects, manual_rules: result.manual_rules };
  }
  function previewGraph(mechanics, edition = '2014', level = 1, choices = {}, subclass = '') {
    const result = evaluateGraph(mechanics, { edition, level, choices, subclass });
    if (result.error) return { error: result.error };
    return { edition: result.sheet.edition, level: result.sheet.level, abilities: result.sheet.abilities, speed: result.sheet.speed,
      hp: result.sheet.hp, saves: result.sheet.saving_throws, skills: result.sheet.skills, skill_choices: result.sheet.skill_choices,
      languages: result.sheet.languages, proficiencies: result.sheet.proficiencies, spells: result.sheet.spell_rules,
      spell_slots: result.sheet.spell_progression.slots, features: result.sheet.features, manual_rules: result.manual_rules,
      equipment: result.effects.filter(e => e.kind === 'equipment').flatMap(e => e.items || []),
      equipment_choices: result.effects.filter(e => e.kind === 'equipment_choice').map(e => ({ id: e.id, title: e.title, options: e.options || [] })),
      class_features: result.sheet.class_features || null, spellcasting: result.sheet.spellcasting || null,
      actions: result.actions.map(p => ({ name: p.name, trigger: p.trigger, blocks: p.blocks.map(b => b.kind) })) };
  }
  // Чистая проверка связи: петля, цикл и общий validateGraph. Возвращает текст ошибки или ''.
  function wouldCycle(links, fromNode, toNode) {
    const next = new Map();
    for (const link of links) { if (!next.has(link.from.node)) next.set(link.from.node, []); next.get(link.from.node).push(link.to.node); }
    const seen = new Set([toNode]), stack = [toNode];
    while (stack.length) {
      const id = stack.pop();
      if (id === fromNode) return true;
      for (const n of next.get(id) || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    return false;
  }
  function connectionError(graph, link) {
    const nodes = new Map((graph.nodes || []).map(n => [n.id, n])), groups = new Map((graph.groups || []).map(g => [g.id, g]));
    const from = nodes.get(link?.from?.node), to = nodes.get(link?.to?.node);
    if (!from || !to) return 'Узел провода не найден.';
    if (from.id === to.id) return 'Нельзя соединить узел с самим собой.';
    const outType = socketMap(from, groups).outputs?.[link.from.socket], inType = socketMap(to, groups).inputs?.[link.to.socket];
    if (!outType || !inType) return 'Сокет не найден.';
    if (!NodeRegistry.sameType(outType, inType)) return `Типы не совпадают: ${outType} → ${inType}.`;
    const owners = actionOwners(graph);
    if (owners.get(from.id) !== owners.get(to.id)) return 'Соединять можно только узлы одного действия.';
    // В конец («Конец») может прийти несколько проводов, поэтому его вход не заменяется.
    const rest = to.type === 'flow.end' ? [...(graph.links || [])] : (graph.links || []).filter(l => !(l.to.node === link.to.node && l.to.socket === link.to.socket));
    if (wouldCycle(rest, link.from.node, link.to.node)) return 'Связь создаёт цикл.';
    // Незавершённый граф (например, не подключено условие у «Если») не блокирует новую связь:
    // отклоняется только ошибка, которую добавила именно эта связь. Полная проверка — при сохранении.
    // Проверку «Начало → Конец» здесь пропускаем: переподключение провода в середине цепочки
    // на миг оставляет поток незавершённым, и это не повод отказывать в связи.
    const groupsList = graph.groups || [];
    const before = graphProblems(graph, groupsList, { completion: false }), after = graphProblems({ ...graph, links: [...rest, link] }, groupsList, { completion: false });
    return after.find(problem => !before.includes(problem)) || '';
  }

  // Стартовые графы для пустого редактора — наборы данных вида graph_starter (static/presets/, реестр Presets).
  const graphStarters = () => window.Presets?.items('graph_starter') || [];
  // Быстрая панель узлов (без поиска): основные узлы действия, чтобы «Конец» и «Начало» всегда были под рукой.
  const QUICK_NODES = ['action.program', 'flow.if', 'flow.end', 'action.roll', 'action.spend', 'condition.hit', 'logic.op'];
  // Действие — отдельная цепочка от узла «Начало» (action.program) до узла «Конец» (flow.end).
  // Узел принадлежит действию по полю action (его ставит редактор). Без поля узел относится
  // к действию, с которым связан проводами; если связей нет — к первому действию.
  function actionOwners(graph) {
    const nodes = graph.nodes || [], programs = nodes.filter(n => n.type === 'action.program');
    const programIds = new Set(programs.map(p => p.id)), owner = new Map();
    for (const p of programs) owner.set(p.id, p.id);
    for (const n of nodes) if (!owner.has(n.id) && programIds.has(n.action)) owner.set(n.id, n.action);
    const adjacency = new Map();
    for (const l of graph.links || []) {
      if (!adjacency.has(l.from.node)) adjacency.set(l.from.node, []);
      if (!adjacency.has(l.to.node)) adjacency.set(l.to.node, []);
      adjacency.get(l.from.node).push(l.to.node); adjacency.get(l.to.node).push(l.from.node);
    }
    for (const p of programs) {
      const stack = [p.id];
      while (stack.length) {
        const id = stack.pop();
        for (const next of adjacency.get(id) || []) {
          if (owner.has(next) || programIds.has(next)) continue;
          owner.set(next, p.id); stack.push(next);
        }
      }
    }
    const first = programs[0]?.id || '';
    for (const n of nodes) if (!owner.has(n.id)) owner.set(n.id, first);
    return owner;
  }
  // Механики одного именованного действия: программа с этим feature_name и все её узлы.
  function mechanicsForFeature(mechanics, name) {
    const graph = graphOf(mechanics);
    const programs = graph.nodes.filter(node => node.type === 'action.program' && node.params?.trigger === 'use' && node.params?.feature_name === name);
    if (!programs.length) return undefined;
    const owners = actionOwners(graph), programIds = new Set(programs.map(node => node.id));
    const keep = new Set(graph.nodes.filter(node => programIds.has(owners.get(node.id))).map(node => node.id));
    const metadata = Object.fromEntries(Object.entries(mechanics).filter(([key]) => key !== 'version' && key !== 'graph'));
    return { ...metadata, version: GRAPH_VERSION, graph: {
      nodes: clone(graph.nodes.filter(node => keep.has(node.id))),
      links: clone(graph.links.filter(link => keep.has(link.from.node) && keep.has(link.to.node))),
      frames: [], groups: clone(graph.groups || []),
    } };
  }
  function graphEditor(doc) {
    const seed = doc.mechanics || graphEnvelope({});
    if (seed.version !== GRAPH_VERSION) throw new Error('Неподдерживаемая схема механик.');
    let mechanics = clone(seed);
    // Записи, сохранённые с полем «Когда», переводятся в узлы при открытии (см. liftWhenGates).
    const liftedWhen = liftWhenGates(mechanics.graph);
    // Форма вызывается с копией записи; исходник не отправляется на сервер до внешнего «Сохранить».
    doc.mechanics = mechanics;
    const graph = mechanics.graph;
    const root = el('section', { class: 'node-editor', tabindex: 0, 'aria-label': 'Редактор графа механик' });
    // Внутренняя оболочка — контейнер для container-query; диалог шаблонов лежит рядом с ней,
    // поэтому перерисовка редактора не выбивает фокус из открытого окна.
    const shell = el('div', { class: 'node-editor-shell' });
    root.append(shell);
    // Наборы стартов могли измениться (импорт или удаление набора): перерисовываем, пока редактор на странице.
    // Открытый диалог шаблонов обновляется на месте: полная перерисовка потеряла бы фокус и введённое название.
    const onPresets = () => {
      if (!root.isConnected) { window.removeEventListener('presets:changed', onPresets); return; }
      if (tpl.open) { refreshTemplatesDialog(); return; }
      render();
    };
    window.addEventListener('presets:changed', onPresets);
    // Читать текущий граф снаружи (тесты, отладка); сам граф редактор не отдаёт наружу иначе.
    root.getGraph = () => graph;
    const history = [JSON.stringify(graph)]; let historyIndex = 0, selected = new Set(), activeNode = '', pendingPort = null,
      status = liftedWhen ? 'Условия «Когда» перенесены в узлы «Если» и «Попадание атаки».' : '', search = '', currentEdition = '2014', currentLevel = 1, currentChoices = {}, currentSubclass = '', view = { x: 40, y: 40, k: 1 }, wire = null, suppressClick = false;
    // Склонение числительных для подсказок шаблонов: 1 узел, 2 узла, 5 узлов.
    const plural = (n, one, few, many) => {
      const mod10 = n % 10, mod100 = n % 100;
      if (mod100 >= 11 && mod100 <= 14) return many;
      return mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many;
    };
    // Состояние диалога шаблонов (разметка и обработчики — в блоке «Диалог шаблонов»).
    const tpl = { open: false, mode: 'browse', tab: 'ready', query: '', name: '', error: '', selected: '', confirmKey: '', confirmButton: null, confirmTimer: 0, overlay: null, refs: {}, opener: null, openerAction: '', lastFocused: null };
    // Превью-провод при перетаскивании от сокета: путь обновляется на pointermove, остальной DOM не трогается.
    let wirePreview = null;
    const field = (label, control) => el('label', { class: 'node-field' }, el('span', {}, label), control);
    // Активное действие и id узлов, которые сейчас показаны на холсте (пересчитываются в render).
    let activeAction = '', shownIds = new Set();
    const snapshot = () => JSON.stringify(graph);
    function checkpoint() {
      const state = snapshot();
      if (history[historyIndex] === state) return;
      history.splice(historyIndex + 1); history.push(state); if (history.length > 80) history.shift(); historyIndex = history.length - 1;
    }
    function restore(index) {
      if (index < 0 || index >= history.length) return;
      const next = JSON.parse(history[index]);
      graph.nodes = next.nodes; graph.links = next.links; graph.frames = next.frames; graph.groups = next.groups;
      historyIndex = index; selected.clear(); activeNode = ''; render();
    }
    function addNode(type, params = null, at = null) {
      if (!NODE_DEFS[type]) return;
      if (type === 'flow.end') return addEndNode();
      if (type === 'action.program') return createAction();
      const id = mkId('node'), count = graph.nodes.length;
      graph.nodes.push({ id, type, params: params ? clone(params) : clone(NODE_DEFS[type].defaults), position: at || { x: 60 + (count % 4) * 250, y: 70 + Math.floor(count / 4) * 170 }, action: activeAction });
      checkpoint(); activeNode = id; selected = new Set([id]); render();
    }
    // «Конец» из тулбара/меню: узел к текущему действию и провод от последнего узла с висячим
    // exec-выходом (если таких несколько — от выбранного, иначе от последнего в цепочке).
    function addEndNode() {
      if (!activeAction) { status = 'Сначала добавьте действие.'; render(); return; }
      const owners = actionOwners(graph);
      if (graph.nodes.some(n => n.type === 'flow.end' && owners.get(n.id) === activeAction)) { status = 'У действия уже есть «Конец».'; render(); return; }
      const program = nodeById(activeAction), flow = program ? flowReach(graph, program) : { dangling: [] };
      if (!flow.dangling.length) { status = 'У действия нечего завершать: добавьте блок.'; render(); return; }
      const chosen = [...selected].map(nodeById).find(node => node && flow.dangling.some(item => item.node === node.id));
      const anchor = chosen || nodeById(flow.dangling.reduce((last, item) => (item.index >= last.index ? item : last), flow.dangling[0]).node);
      const end = { id: mkId('node'), type: 'flow.end', params: {}, position: { x: (anchor?.position?.x || 0) + 260, y: anchor?.position?.y || 0 }, action: activeAction };
      graph.nodes.push(end);
      for (const item of flow.dangling.filter(dangling => dangling.node === anchor?.id)) graph.links.push({ from: { node: item.node, socket: item.socket }, to: { node: end.id, socket: 'exec' } });
      checkpoint(); selected = new Set([end.id]); activeNode = end.id; status = ''; render();
    }
    // Копии выделенных узлов со сдвигом; связи не копируются. block_id действия создаётся заново (уникален в графе).
    function duplicateNodes(ids) {
      const source = graph.nodes.filter(n => ids.includes(n.id) && n.type !== 'action.program');
      if (!source.length) return;
      const copies = source.map(n => {
        const params = clone(n.params || {});
        if (actionType(n.type)) params.block_id = mkId('b');
        return { id: mkId('node'), type: n.type, params, position: { x: n.position.x + 40, y: n.position.y + 40 }, action: activeAction };
      });
      graph.nodes.push(...copies);
      checkpoint(); selected = new Set(copies.map(n => n.id)); activeNode = copies[0].id; render();
    }
    // Пустое действие: только «Начало» и «Конец» (и выключенные блоки), тогда можно вставить готовый граф.
    function isBlankAction() {
      if (!activeAction) return false;
      const owners = actionOwners(graph);
      return graph.nodes.every(n => owners.get(n.id) !== activeAction || n.type === 'action.program' || n.type === 'flow.end' || (n.type === 'action.spend' && n.params?.enabled === false));
    }
    // Вставка стартового графа в пустой редактор: новые ID, позиции от левого верхнего угла видимой области.
    function insertStarter(starter) {
      const anchor = nodeById(activeAction);
      const ids = new Map(), origin = anchor?.position ? { x: anchor.position.x + 280, y: anchor.position.y } : { x: 60, y: 70 };
      for (const n of starter.nodes) {
        const id = mkId('node'); ids.set(n.key, id);
        // Значения по умолчанию реестра + отличия из пресета; block_id действия создаётся заново (уникален в графе).
        const params = { ...clone(defOf(n.type)?.defaults || {}), ...clone(n.params || {}) };
        if (actionType(n.type)) params.block_id = mkId('b');
        const inserted = { id, type: n.type, params, position: { x: origin.x + n.x, y: origin.y + n.y }, action: activeAction };
        graph.nodes.push(inserted);
      }
      for (const [from, fromSocket, to, toSocket] of starter.links) graph.links.push({ from: { node: ids.get(from), socket: fromSocket }, to: { node: ids.get(to), socket: toSocket } });
      // Вариант «с подключением»: первый узел без входящих связей пресета встаёт после программы «Использовать».
      const program = nodeById(activeAction);
      // Стиль кнопки (иконка) задаётся в «Начале»; меняем его, только если там стиль по умолчанию.
      if (starter.style && program && (!program.params?.style || program.params.style === 'default')) program.params = { ...program.params, style: starter.style };
      // Голова цепочки — первый узел с exec-входом, на который не ведёт exec-провод пресета:
      // провод условия на вход condition не делает блок продолжением потока.
      const head = starter.nodes.find(n => !starter.links.some(([, , to, into]) => to === n.key && into === 'exec'));
      if (starter.attach && program && head && defOf(head.type)?.inputs?.exec) {
        // Прямой провод «Начало» → «Конец» (действие было пустым) заменяем цепочкой шаблона:
        // «Начало» → первый узел, висячие exec-выходы цепочки → тот же «Конец».
        const direct = graph.links.find(l => l.from.node === program.id && l.from.socket === 'exec' && nodeById(l.to.node)?.type === 'flow.end');
        const hasChain = graph.links.some(l => l.from.node === program.id && l.from.socket === 'exec' && nodeById(l.to.node)?.type !== 'flow.end');
        if (!hasChain) {
          if (direct) graph.links = graph.links.filter(l => l !== direct);
          graph.links.push({ from: { node: program.id, socket: 'exec' }, to: { node: ids.get(head.key), socket: 'exec' } });
          if (direct) {
            for (const id of ids.values()) {
              for (const [socket, type] of Object.entries(defOf(nodeById(id)?.type)?.outputs || {})) {
                if (type !== 'flow') continue;
                if (graph.links.some(l => l.from.node === id && l.from.socket === socket)) continue;
                graph.links.push({ from: { node: id, socket }, to: { node: direct.to.node, socket: 'exec' } });
              }
            }
          }
        }
      }
      checkpoint(); selected = new Set(); activeNode = ''; status = ''; render();
    }
    // Шаблоны графов: свои цепочки хранятся в наборе graph_starter пользовательского слоя Presets (в этом браузере).
    const ownTemplate = id => Boolean(window.Presets?.ownItemOf('graph_starter', id));
    // Узлы действия, которые входят в шаблон: без «Начала», «Конца» и групп (их связывает само действие).
    function templateBody() {
      const owners = actionOwners(graph);
      return graph.nodes.filter(n => owners.get(n.id) === activeAction && n.type !== 'action.program' && n.type !== 'flow.end' && !n.type.startsWith('group.'));
    }
    // Сборка шаблона из узлов действия. Возвращает { item } или { error } — диалог показывает ошибку на месте.
    function makeTemplate(name) {
      const body = templateBody(), trimmed = String(name || '').trim();
      if (!trimmed) return { error: 'Укажите название шаблона.' };
      if (!body.length) return { error: 'В действии нет узлов для шаблона.' };
      const ids = new Map(body.map((n, i) => [n.id, 'n' + i]));
      const minX = Math.min(...body.map(n => n.position?.x || 0)), minY = Math.min(...body.map(n => n.position?.y || 0));
      const nodes = body.map(n => {
        const { block_id: _block, ...params } = n.params || {};
        return { key: ids.get(n.id), type: n.type, params: clone(params), x: (n.position?.x || 0) - minX, y: (n.position?.y || 0) - minY };
      });
      const links = graph.links.filter(l => ids.has(l.from.node) && ids.has(l.to.node)).map(l => [ids.get(l.from.node), l.from.socket, ids.get(l.to.node), l.to.socket]);
      // Голова — узел с exec-входом без входящего exec-провода (провод условия не в счёт).
      const head = body.find(n => defOf(n.type)?.inputs?.exec && !links.some(([, , to, into]) => to === ids.get(n.id) && into === 'exec'));
      const item = { id: 'my-' + Date.now().toString(36), name: trimmed, hint: `Свой шаблон: ${body.length} ${plural(body.length, 'узел', 'узла', 'узлов')}`, attach: Boolean(head), nodes, links };
      try { window.Presets.upsertUserItem('graph_starter', item); } catch (e) { return { error: e.message }; }
      return { item };
    }
    // Сохранение из старой полосы (совместимый вход): статус и перерисовка редактора.
    function saveTemplate(name) {
      const result = makeTemplate(name);
      status = result.error || `Шаблон «${result.item.name}» сохранён.`;
      render();
      return result;
    }
    // Удаление своего шаблона/группы из пользовательского слоя. Перерисовку делает вызывающий диалог.
    function removeTemplate(kind, id) {
      window.Presets.removeUserItem(kind === 'group' ? 'graph_group' : 'graph_starter', id);
      return kind === 'group' ? 'Шаблон группы удалён.' : 'Свой шаблон удалён.';
    }
    // Группа нод как пользовательский шаблон: набор graph_group в Presets (в этом браузере). Вставка копирует определение группы.
    const groupTemplates = () => window.Presets?.items('graph_group') || [];
    function saveGroupTemplate(group) {
      const item = { id: mkId('group-tpl'), name: group.name, inputs: clone(group.inputs || []), outputs: clone(group.outputs || []), nodes: clone(group.nodes || []), links: clone(group.links || []) };
      try { window.Presets.upsertUserItem('graph_group', item); } catch (e) { status = e.message; return render(); }
      status = `Группа «${item.name}» сохранена в шаблоны.`; render();
    }
    function insertGroupTemplate(item) {
      const groupId = mkId('group'), id = mkId('instance');
      graph.groups.push({ id: groupId, name: item.name, inputs: clone(item.inputs), outputs: clone(item.outputs), nodes: clone(item.nodes), links: clone(item.links), frames: [] });
      graph.nodes.push({ id, type: 'group.instance', params: { group_id: groupId }, position: { x: 80 + graph.nodes.length * 28, y: 80 + graph.nodes.length * 24 }, action: activeAction });
      checkpoint(); activeNode = id; selected = new Set([id]); status = `Группа «${item.name}» вставлена из шаблона.`; render();
    }
    function removeGroupTemplate(id) {
      window.Presets.removeUserItem('graph_group', id);
      status = 'Шаблон группы удалён.'; render();
    }

    // -----------------------------------------------------------------------
    // Диалог шаблонов действий: готовые наборы, свои цепочки и группы.
    // Окно вставляется в root редактора, а не в body; позиционируется fixed,
    // чтобы внешняя модалка записи не обрезала его.
    // -----------------------------------------------------------------------
    const PREVIEW_NS = 'http://www.w3.org/2000/svg';
    const TEMPLATE_TABS = [
      { id: 'ready', label: 'Готовые' },
      { id: 'mine', label: 'Мои' },
      { id: 'groups', label: 'Группы' },
    ];
    const ownGroupTemplate = id => Boolean(window.Presets?.ownItemOf('graph_group', id));
    const templateOwn = (kind, id) => (kind === 'group' ? ownGroupTemplate(id) : ownTemplate(id));
    function templateCatalog() {
      const starters = graphStarters();
      return { ready: starters.filter(item => !ownTemplate(item.id)), mine: starters.filter(item => ownTemplate(item.id)), groups: groupTemplates() };
    }
    function templateNodesOf(item) { return Array.isArray(item?.nodes) ? item.nodes.filter(node => node && node.type) : []; }
    function templateHaystack(kind, item) {
      if (kind === 'group') return [item.name, ...(item.inputs || []).map(port => port.name), ...(item.outputs || []).map(port => port.name)].join(' ').toLocaleLowerCase();
      return `${item.name || ''} ${item.hint || ''}`.toLocaleLowerCase();
    }
    function previewTag(tag, attrs = {}) {
      const node = document.createElementNS(PREVIEW_NS, tag);
      for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) node.setAttribute(key, value);
      return node;
    }
    // Мини-превью графа 180×100: рамки узлов цветом категории, связи линиями.
    // Координаты нормализуются; шаблоны без позиций (или все в одной точке) раскладываются сеткой.
    function templatePreview(kind, item) {
      const svg = previewTag('svg', { class: 'templates-preview-svg', viewBox: '0 0 180 100', width: '180', height: '100', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true', focusable: 'false' });
      const nodes = templateNodesOf(item);
      if (!nodes.length) { svg.append(previewTag('rect', { x: 55, y: 38, width: 70, height: 24, rx: 6, class: 'templates-preview-empty' })); return svg; }
      const keyOf = node => (kind === 'group' ? node.id : node.key);
      const coords = nodes.map((node, index) => {
        const x = Number(node.x ?? node.position?.x), y = Number(node.y ?? node.position?.y);
        return { node, index, x: Number.isFinite(x) ? x : null, y: Number.isFinite(y) ? y : null };
      });
      // Нет координат или все узлы в одной точке — раскладываем ровной сеткой.
      const noPositions = coords.some(point => point.x === null || point.y === null);
      const onePoint = !noPositions && coords.every(point => Math.abs(point.x - coords[0].x) < 1 && Math.abs(point.y - coords[0].y) < 1);
      if (noPositions || onePoint) {
        const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
        coords.forEach((point, index) => { point.x = index % cols; point.y = Math.floor(index / cols); });
      }
      const xs = coords.map(point => point.x), ys = coords.map(point => point.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const many = nodes.length > 6, boxW = many ? 34 : 46, boxH = many ? 16 : 22, margin = 8;
      const left = margin + boxW / 2, right = 180 - margin - boxW / 2, top = margin + boxH / 2, bottom = 100 - margin - boxH / 2;
      const pointOf = point => ({
        x: maxX - minX < 1 ? 90 : left + ((point.x - minX) / (maxX - minX)) * (right - left),
        y: maxY - minY < 1 ? 50 : top + ((point.y - minY) / (maxY - minY)) * (bottom - top),
      });
      const points = new Map(coords.map(point => [keyOf(point.node), pointOf(point)]));
      for (const link of Array.isArray(item.links) ? item.links : []) {
        const from = Array.isArray(link) ? link[0] : link?.from?.node, to = Array.isArray(link) ? link[2] : link?.to?.node;
        const a = points.get(from), b = points.get(to);
        if (!a || !b) continue;
        svg.append(previewTag('line', { x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1), class: 'templates-preview-link' }));
      }
      for (const point of coords) {
        const center = points.get(keyOf(point.node)), category = NodeRegistry.categoryOf(point.node.type)?.id || 'other';
        svg.append(previewTag('rect', { x: (center.x - boxW / 2).toFixed(1), y: (center.y - boxH / 2).toFixed(1), width: boxW, height: boxH, rx: 4,
          class: `templates-preview-node cat-${category}`, 'data-node-type': point.node.type }));
      }
      return svg;
    }
    function templateHint(kind, item) {
      if (kind === 'group') {
        const inputs = (item.inputs || []).length, outputs = (item.outputs || []).length;
        return `Входы: ${inputs} · Выходы: ${outputs}`;
      }
      return item.hint || (item.attach ? 'Цепочка подключится между «Началом» и «Концом».' : 'Набор узлов для действия.');
    }
    function templateMeta(kind, item) {
      const count = templateNodesOf(item).length;
      const nodes = `${count} ${plural(count, 'узел', 'узла', 'узлов')}`;
      return kind === 'group' ? `группа · ${nodes}` : `${nodes} · ${templateOwn(kind, item.id) ? 'мой' : 'готовый'}`;
    }
    function templateCard(kind, item) {
      const key = `${kind}:${item.id}`, own = templateOwn(kind, item.id), hint = templateHint(kind, item);
      const card = el('article', { class: 'templates-card' + (tpl.selected === key ? ' selected' : ''), tabindex: '0', 'data-template-kind': kind, 'data-template-id': item.id,
        'aria-label': `${item.name || 'Без названия'}. ${templateMeta(kind, item)}`,
        onclick: e => { if (e.target.closest?.('button')) return; selectTemplateCard(key); },
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTemplateCard(key); } } },
        el('div', { class: 'templates-preview' }, templatePreview(kind, item)),
        el('div', { class: 'templates-card-body' },
          el('div', { class: 'templates-card-title' }, el('b', {}, item.name || 'Без названия'), el('span', { class: 'templates-badge ' + (own ? 'mine' : 'ready') }, own ? 'мой' : 'готовый')),
          el('p', { class: 'templates-card-hint muted small' }, hint),
          el('div', { class: 'templates-card-meta muted small' }, templateMeta(kind, item))),
        el('div', { class: 'templates-card-actions' },
          el('button', { class: 'small primary', 'data-template-insert': item.id, disabled: activeAction ? null : '', title: activeAction ? `Вставить «${item.name}»` : 'Сначала добавьте действие',
            onclick: e => { e.stopPropagation(); insertTemplateFromDialog(kind, item); } }, kind === 'group' ? 'Вставить группу' : 'Вставить'),
          own ? el('button', { class: 'small danger', 'data-template-delete': item.id, title: kind === 'group' ? 'Удалить свой шаблон группы' : 'Удалить свой шаблон',
            onclick: e => { e.stopPropagation(); armTemplateDelete(e.currentTarget, kind, item); } }, 'Удалить') : null));
      return card;
    }
    function selectTemplateCard(key) {
      tpl.selected = tpl.selected === key ? '' : key;
      for (const card of tpl.refs.grid?.querySelectorAll?.('.templates-card') || []) {
        card.classList.toggle('selected', `${card.dataset.templateKind}:${card.dataset.templateId}` === tpl.selected);
      }
    }
    function resetTemplateConfirm() {
      if (tpl.confirmTimer) clearTimeout(tpl.confirmTimer);
      tpl.confirmTimer = 0;
      if (tpl.confirmButton?.isConnected) { tpl.confirmButton.textContent = 'Удалить'; tpl.confirmButton.classList.remove('confirm'); }
      tpl.confirmKey = ''; tpl.confirmButton = null;
    }
    function armTemplateDelete(button, kind, item) {
      const key = `${kind}:${item.id}`;
      if (tpl.confirmKey === key) { resetTemplateConfirm(); deleteTemplateItem(kind, item); return; }
      resetTemplateConfirm();
      tpl.confirmKey = key; tpl.confirmButton = button;
      button.textContent = 'Точно удалить?';
      button.classList.add('confirm');
      tpl.confirmTimer = setTimeout(() => { tpl.confirmTimer = 0; resetTemplateConfirm(); }, 3000);
    }
    function deleteTemplateItem(kind, item) {
      status = removeTemplate(kind, item.id);
      resetTemplateConfirm();
      refreshTemplatesDialog();
      // Оболочка редактора перерисовывается, а окно остаётся на месте: полка групп и стартеры
      // за диалогом больше не показывают удалённый шаблон.
      render();
      tpl.refs.tabs?.querySelector?.(`[data-templates-tab="${tpl.tab}"]`)?.focus?.();
    }
    function insertTemplateFromDialog(kind, item) {
      if (!activeAction) { status = 'Сначала добавьте действие.'; return; }
      const name = item.name || 'шаблон';
      closeTemplatesDialog({ restoreFocus: false });
      if (kind === 'group') insertGroupTemplate(item); else insertStarter(item);
      status = kind === 'group' ? `Группа «${name}» вставлена.` : `Шаблон «${name}» вставлен.`;
      window.toast?.(status);
      render();
      focusTemplatesOpener();
    }
    function templateSaveState() {
      if (!tpl.refs.saveButton) return;
      const count = activeAction ? templateBody().length : 0;
      tpl.refs.saveButton.disabled = !activeAction || count === 0;
      tpl.refs.saveHint.textContent = !activeAction ? 'Сначала добавьте действие — шаблон сохраняется из узлов текущего действия.'
        : count === 0 ? 'В действии нет узлов, кроме «Начала» и «Конца», — сохранять нечего.'
          : `В шаблон войдут узлы действия, кроме «Начала», «Конца» и групп: ${count} ${plural(count, 'узел', 'узла', 'узлов')}.`;
      tpl.refs.saveError.textContent = tpl.error;
      tpl.refs.saveError.hidden = !tpl.error;
    }
    function submitTemplateSave() {
      if (!tpl.open || tpl.mode !== 'save' || tpl.refs.saveButton?.disabled) return;
      const result = makeTemplate(tpl.name);
      if (result.error) { tpl.error = result.error; templateSaveState(); tpl.refs.name?.focus?.(); return; }
      tpl.error = '';
      const message = `Шаблон «${result.item.name}» сохранён.`;
      closeTemplatesDialog({ restoreFocus: false });
      status = message;
      window.toast?.(message);
      render();
      focusTemplatesOpener();
    }
    function templateTabs(counts) {
      return TEMPLATE_TABS.map(({ id, label }) => el('button', { class: 'templates-tab', type: 'button', role: 'tab', 'data-templates-tab': id,
        'aria-selected': tpl.tab === id ? 'true' : 'false', tabindex: tpl.tab === id ? '0' : '-1',
        onclick: () => { if (tpl.tab === id) return; tpl.tab = id; refreshTemplatesDialog(); tpl.refs.tabs?.querySelector?.(`[data-templates-tab="${id}"]`)?.focus?.(); } },
      label, el('span', { class: 'templates-count' }, String(counts[id] || 0))));
    }
    // Текст пустого состояния: подсказка отличается для «Моих», групп и поиска.
    function templatesEmptyText(tab, query) {
      if (query) return 'Ничего не найдено по запросу.';
      if (tab === 'mine') return 'Своих шаблонов пока нет — соберите цепочку и нажмите «Сохранить как шаблон».';
      if (tab === 'groups') return 'Своих групп пока нет. Соберите узлы, нажмите «Сгруппировать», затем «В шаблоны» в списке групп над холстом.';
      return 'Готовых шаблонов пока нет.';
    }
    function refreshTemplatesDialog() {
      if (!tpl.open || !tpl.refs.grid) return;
      const catalog = templateCatalog(), query = tpl.query.trim().toLocaleLowerCase(), items = catalog[tpl.tab] || [];
      const kind = tpl.tab === 'groups' ? 'group' : 'starter';
      tpl.refs.tabs.replaceChildren(...templateTabs({ ready: catalog.ready.length, mine: catalog.mine.length, groups: catalog.groups.length }));
      const shown = query ? items.filter(item => templateHaystack(kind, item).includes(query)) : items;
      tpl.refs.grid.replaceChildren(...shown.map(item => templateCard(kind, item)));
      tpl.refs.grid.hidden = shown.length === 0;
      tpl.refs.empty.textContent = shown.length ? '' : templatesEmptyText(tpl.tab, query);
      tpl.refs.empty.hidden = shown.length > 0;
      templateSaveState();
    }
    function focusTemplatesOpener() {
      const target = (tpl.opener?.isConnected ? tpl.opener : root.querySelector?.(`[data-action="${tpl.openerAction}"]`));
      target?.focus?.();
    }
    function closeTemplatesDialog({ restoreFocus = true } = {}) {
      if (!tpl.open) return;
      tpl.open = false;
      resetTemplateConfirm();
      tpl.overlay?.remove();
      tpl.overlay = null; tpl.refs = {}; tpl.lastFocused = null;
      if (restoreFocus) focusTemplatesOpener();
    }
    // Простой focus-trap: Tab и Shift+Tab не выходят за пределы панели.
    function trapTemplatesFocus(event) {
      const panel = tpl.refs.panel;
      if (!panel) return;
      const focusables = [...panel.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
        .filter(node => !node.disabled && node.getClientRects().length);
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1], active = document.activeElement;
      if (!panel.contains(active)) { event.preventDefault(); first.focus(); return; }
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    }
    function openTemplatesDialog(mode = 'browse') {
      if (tpl.open) return;
      resetTemplateConfirm();
      tpl.open = true; tpl.mode = mode === 'save' ? 'save' : 'browse'; tpl.tab = 'ready';
      tpl.query = ''; tpl.name = ''; tpl.error = ''; tpl.selected = ''; tpl.lastFocused = null;
      tpl.openerAction = tpl.mode === 'save' ? 'save-template' : 'templates-dialog';
      tpl.opener = root.querySelector?.(`[data-action="${tpl.openerAction}"]`);
      const program = nodeById(activeAction), actionName = program?.params?.name || program?.params?.feature_name || '';
      const overlay = el('div', { class: 'templates-overlay', 'data-templates-overlay': '',
        onclick: e => { if (e.target === overlay) closeTemplatesDialog(); } });
      const panel = el('div', { class: 'templates-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Шаблоны действий', 'data-templates-panel': '', tabindex: '-1' });
      const head = el('div', { class: 'templates-head' },
        el('div', { class: 'templates-head-text' },
          el('h2', { class: 'templates-title' }, 'Шаблоны действий'),
          el('p', { class: 'templates-subtitle muted small' }, actionName ? `Действие: «${actionName}»` : 'Действие не выбрано — сначала добавьте действие.')),
        el('button', { class: 'templates-close', type: 'button', title: 'Закрыть', 'aria-label': 'Закрыть шаблоны', onclick: () => closeTemplatesDialog() }, '×'));
      const nameInput = el('input', { class: 'templates-name', type: 'text', maxlength: '80', value: tpl.name, placeholder: 'Название шаблона', 'aria-label': 'Название шаблона',
        oninput: e => { tpl.name = e.target.value; tpl.error = ''; templateSaveState(); },
        onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); submitTemplateSave(); } } });
      const saveButton = el('button', { class: 'primary', type: 'button', onclick: () => submitTemplateSave() }, 'Сохранить');
      const saveHint = el('p', { class: 'templates-save-hint muted small', 'aria-live': 'polite' });
      const saveError = el('p', { class: 'templates-save-error', role: 'alert', hidden: '' });
      const saveBar = tpl.mode === 'save' ? el('div', { class: 'templates-save' },
        el('div', { class: 'templates-save-row' },
          el('label', { class: 'templates-name-field' }, el('span', {}, 'Название шаблона'), nameInput), saveButton),
        saveHint, saveError) : null;
      const searchInput = el('input', { class: 'templates-search-input', type: 'search', value: tpl.query, placeholder: 'Поиск по названию или подсказке…', 'aria-label': 'Поиск шаблонов',
        oninput: e => { tpl.query = e.target.value; refreshTemplatesDialog(); } });
      const tabs = el('div', { class: 'templates-tabs', role: 'tablist', 'aria-label': 'Виды шаблонов', onkeydown: e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault(); e.stopPropagation();
        const order = TEMPLATE_TABS.map(tab => tab.id), index = order.indexOf(tpl.tab), step = e.key === 'ArrowRight' ? 1 : order.length - 1;
        tpl.tab = order[(index + step) % order.length];
        refreshTemplatesDialog();
        tpl.refs.tabs?.querySelector?.(`[data-templates-tab="${tpl.tab}"]`)?.focus?.();
      } });
      const grid = el('div', { class: 'templates-grid' });
      const empty = el('p', { class: 'templates-empty muted', 'data-templates-empty': '', hidden: '' });
      panel.append(...[head, saveBar, el('div', { class: 'templates-search' }, searchInput), tabs, el('div', { class: 'templates-body' }, grid, empty)].filter(Boolean));
      overlay.append(panel);
      overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTemplatesDialog(); return; }
        if (e.key === 'Tab') trapTemplatesFocus(e);
        e.stopPropagation();
      });
      overlay.addEventListener('focusin', () => { tpl.lastFocused = document.activeElement; });
      tpl.overlay = overlay;
      tpl.refs = { overlay, panel, tabs, grid, empty, search: searchInput, name: nameInput, saveButton, saveHint, saveError };
      root.append(overlay);
      refreshTemplatesDialog();
      (tpl.mode === 'save' ? nameInput : searchInput).focus();
    }

    function portType(node, direction, socket) {
      const groups = new Map(graph.groups.map(g => [g.id, g]));
      return socketMap(node, groups)[direction]?.[socket];
    }
    function portLabel(node, direction, socket) {
      if (node.type !== 'group.instance') return socket;
      const group = graph.groups.find(item => item.id === node.params?.group_id), list = direction === 'inputs' ? group?.inputs : group?.outputs;
      return list?.find(item => item.id === socket)?.name || socket;
    }
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    // Привязка (snap) к ближайшему совместимому сокету в экранных пикселях: как в Blender, магнит ~24 px.
    const SNAP_DISTANCE = 24;
    // Гладкая Безье с горизонтальными касательными: провод входит в сокет ровно слева/справа.
    const wireCurve = (x1, y1, x2, y2) => { const d = Math.max(60, Math.abs(x2 - x1) / 2); return `M ${x1} ${y1} C ${x1 + d} ${y1}, ${x2 - d} ${y2}, ${x2} ${y2}`; };
    const canvasEl = () => root.querySelector?.('.node-canvas');
    const canvasRect = () => canvasEl()?.getBoundingClientRect?.() || { left: 0, top: 0 };
    const worldPointIn = (rect, clientX, clientY) => ({ x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k });
    const worldPoint = (clientX, clientY) => worldPointIn(canvasRect(), clientX, clientY);
    // Сетка холста — фоновые градиенты (две шкалы), поэтому панорама и зум двигают её без canvas.
    function applyView() {
      const world = root.querySelector?.('.node-world'); if (world) world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
      const canvas = canvasEl();
      if (!canvas) return;
      canvas.setAttribute('data-zoom', view.k.toFixed(2));
      const minor = 20 * view.k, major = 100 * view.k, px = value => `${value.toFixed(2)}px`;
      // На сильном отдалении мелкая шкала сливается в кашу — прячем её, крупная остаётся ориентиром.
      const small = minor >= 10 ? `${px(minor)} ${px(minor)}` : '0 0';
      canvas.style.backgroundSize = `${px(major)} ${px(major)}, ${px(major)} ${px(major)}, ${small}, ${small}`;
      canvas.style.backgroundPosition = `${px(view.x)} ${px(view.y)}, ${px(view.x)} ${px(view.y)}, ${px(view.x)} ${px(view.y)}, ${px(view.x)} ${px(view.y)}`;
    }
    // Слушатели на document на время жеста (перетаскивание, панорама, рамка, провод); снимаются сами.
    function track(onMove, onUp) {
      const move = e => onMove(e);
      const up = e => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); onUp(e); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    }
    function zoomAt(clientX, clientY, factor) {
      const rect = canvasRect(), cx = clientX - rect.left, cy = clientY - rect.top;
      const k = clamp(view.k * factor, 0.3, 2.5), wx = (cx - view.x) / view.k, wy = (cy - view.y) / view.k;
      view.k = k; view.x = cx - wx * k; view.y = cy - wy * k; applyView();
    }
    function startPan(e) {
      const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      track(m => { view.x = start.vx + m.clientX - start.x; view.y = start.vy + m.clientY - start.y; applyView(); }, () => {});
    }
    function refreshWires() {
      const world = root.querySelector?.('.node-world'); if (!world) return;
      world.querySelector('.node-wires')?.remove(); wirePreview = null; drawWires(world);
    }
    function startDrag(e, node) {
      if (e.button !== 0) return;
      e.preventDefault?.();
      // С Ctrl/Shift выбор меняет клик (см. onclick карточки), поэтому здесь выделение не трогаем.
      const modifier = e.ctrlKey || e.metaKey || e.shiftKey;
      if (!selected.has(node.id) && !modifier) { selected = new Set([node.id]); activeNode = node.id; }
      const ids = selected.has(node.id) ? [...selected] : [node.id];
      const items = ids.map(id => nodeById(id)).filter(Boolean).map(n => ({ node: n, left: n.position?.x || 0, top: n.position?.y || 0 }));
      const start = { x: e.clientX, y: e.clientY }; let moved = false;
      track(m => {
        if (!moved && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 3) return;
        moved = true; suppressClick = true;
        const dx = (m.clientX - start.x) / view.k, dy = (m.clientY - start.y) / view.k;
        for (const item of items) {
          moveNode(item.node, item.left + dx, item.top + dy);
          const card = root.querySelector?.(`[data-node-id="${item.node.id}"]`);
          if (card) card.style.cssText = `left:${item.node.position.x}px;top:${item.node.position.y}px`;
        }
        refreshWires();
      }, () => { if (moved) { checkpoint(); render(); } });
    }
    // Рамочное выделение по DOM-прямоугольникам карточек; Ctrl/Shift добавляет к выбранным.
    function startMarquee(e) {
      const additive = e.ctrlKey || e.metaKey || e.shiftKey, start = { x: e.clientX, y: e.clientY }, base = additive ? [...selected] : [];
      const rect0 = canvasRect(); let box = null;
      track(m => {
        if (!box) { if (Math.hypot(m.clientX - start.x, m.clientY - start.y) < 4) return; box = document.createElement('div'); box.className = 'node-marquee'; canvasEl()?.append(box); }
        box.style.left = `${Math.min(start.x, m.clientX) - rect0.left}px`; box.style.top = `${Math.min(start.y, m.clientY) - rect0.top}px`;
        box.style.width = `${Math.abs(m.clientX - start.x)}px`; box.style.height = `${Math.abs(m.clientY - start.y)}px`;
      }, up => {
        box?.remove();
        if (!box) { if (!additive) { selected = new Set(); activeNode = ''; render(); } return; }
        const l = Math.min(start.x, up.clientX), r = Math.max(start.x, up.clientX), t = Math.min(start.y, up.clientY), b = Math.max(start.y, up.clientY);
        const hit = [...root.querySelectorAll('[data-node-id]')].filter(c => { const q = c.getBoundingClientRect(); return q.right >= l && q.left <= r && q.bottom >= t && q.top <= b; }).map(c => c.dataset.nodeId);
        selected = new Set([...base, ...hit]); activeNode = hit.at(-1) || activeNode; render();
      });
    }
    // Центр кружка сокета в мировых координатах. Читает getBoundingClientRect только на момент вызова
    // (перерисовка провода или начало жеста), а не на каждом pointermove.
    function socketDotAnchor(socketEl, rect) {
      const dot = socketEl?.querySelector?.('i') || socketEl;
      const box = dot?.getBoundingClientRect?.();
      if (!box || !box.width) return null;
      return worldPointIn(rect, box.left + box.width / 2, box.top + box.height / 2);
    }
    // Жест провода: совместимые сокеты, их точки и прямоугольник холста считаются один раз.
    // Узлы во время жеста не двигаются, поэтому кэш не устаревает; превью обновляется одной строкой path.
    function beginWireDrag(node, direction, socket, type) {
      const rect = canvasRect();
      const sockets = Array.from(root.querySelectorAll?.('.node-socket') || []);
      const candidates = [];
      for (const item of sockets) {
        const compatible = item.dataset.dir !== direction && item.dataset.node !== node.id && NodeRegistry.sameType(item.dataset.type, type);
        item.classList.toggle('compatible', compatible);
        if (!compatible) continue;
        const anchor = socketDotAnchor(item, rect);
        if (anchor) candidates.push({ node: item.dataset.node, socket: item.dataset.socket, dir: item.dataset.dir, el: item, anchor });
      }
      const originEl = sockets.find(item => item.dataset.node === node.id && item.dataset.dir === direction && item.dataset.socket === socket) || null;
      originEl?.classList.add('wire-origin');
      canvasEl()?.classList.add('wiring');
      return { rect, candidates, originAnchor: (originEl && socketDotAnchor(originEl, rect)) || socketAnchor(node.id, direction, socket, rect), snap: null };
    }
    // На pointermove двигаем только превью-путь: DOM карточек и остальные провода не перерисовываются.
    function updateWireDrag(drag, event) {
      const pointer = worldPointIn(drag.rect, event.clientX, event.clientY);
      let best = null, bestDistance = SNAP_DISTANCE;
      for (const candidate of drag.candidates) {
        const distance = Math.hypot(candidate.anchor.x - pointer.x, candidate.anchor.y - pointer.y) * view.k;
        if (distance < bestDistance) { bestDistance = distance; best = candidate; }
      }
      if (best !== drag.snap) { drag.snap?.el.classList.remove('snap'); best?.el.classList.add('snap'); drag.snap = best; }
      const end = best ? best.anchor : pointer, origin = drag.originAnchor;
      wire = { ...wire, x: end.x, y: end.y, snap: best };
      wirePreview?.setAttribute('d', wire.direction === 'outputs' ? wireCurve(origin.x, origin.y, end.x, end.y) : wireCurve(end.x, end.y, origin.x, origin.y));
    }
    // Куда бросили провод: сокет под курсором важнее магнита, чтобы явный бросок на несовместимый порт отменялся.
    function wireDropTarget(event, w) {
      const hit = document.elementFromPoint?.(event.clientX, event.clientY)?.closest?.('.node-socket');
      if (hit) return { node: hit.dataset.node, socket: hit.dataset.socket, dir: hit.dataset.dir };
      return w?.snap ? { node: w.snap.node, socket: w.snap.socket, dir: w.snap.dir } : null;
    }
    // Провод от выхода или входа: совместимые сокеты подсвечиваются, несовместимые приглушаются,
    // при отпускании над несовместимым портом связь отменяется с сообщением.
    function startWire(e, node, socket, direction) {
      if (e.button !== 0) return;
      e.stopPropagation();
      const type = portType(node, direction, socket), start = { x: e.clientX, y: e.clientY };
      let moved = false, detached = null, drag = null;
      const origin = { node: node.id, socket, direction, type };
      track(m => {
        if (!moved) {
          if (Math.hypot(m.clientX - start.x, m.clientY - start.y) < 4) return;
          moved = true;
          // Тянем уже подключённый вход: связь снимается на время жеста, при неудаче возвращается.
          if (direction === 'inputs' && node.type !== 'flow.end') { detached = graph.links.find(l => l.to.node === node.id && l.to.socket === socket) || null; if (detached) graph.links = graph.links.filter(l => l !== detached); }
          drag = beginWireDrag(node, direction, socket, type);
          wire = { ...origin, x: drag.originAnchor.x, y: drag.originAnchor.y, snap: null };
          // Единственная полная перерисовка проводов за жест: здесь создаётся preview-path.
          refreshWires();
        }
        if (!wire) return;
        updateWireDrag(drag, m);
      }, up => {
        const w = wire;
        if (!moved || !w) return;
        wire = null;
        const target = wireDropTarget(up, w);
        const restore = () => { if (detached) graph.links.push(detached); };
        if (target) {
          if (target.dir === w.direction) {
            // Бросили на сокет того же направления: связь возвращается, это не удаление.
            restore(); const message = 'Соединять можно только входы с выходами.'; status = message; window.toast?.(message); render(); return;
          }
          const other = { node: target.node, socket: target.socket }, mine = { node: w.node, socket: w.socket };
          const out = w.direction === 'outputs' ? mine : other, inp = w.direction === 'outputs' ? other : mine;
          applyLink({ from: { node: out.node, socket: out.socket }, to: { node: inp.node, socket: inp.socket } }, 'Провод соединён.', restore);
          return;
        }
        // Подключённый вход перетащили на пустое место: связь удаляется (без отката).
        status = detached ? 'Провод удалён.' : ''; render();
      });
    }
    // Связь через клик: сначала выход, затем вход. Проверка и откат — в applyLink.
    function applyLink(link, ok, rollback = null) {
      const error = connectionError(graph, link);
      if (error) { rollback?.(); status = error; window.toast?.(error); render(); return false; }
      if (graph.nodes.find(n => n.id === link.to.node)?.type !== 'flow.end') graph.links = graph.links.filter(l => !(l.to.node === link.to.node && l.to.socket === link.to.socket));
      graph.links.push(clone(link));
      checkpoint(); pendingPort = null; status = ok; render(); return true;
    }
    function removeLink(link) { graph.links = graph.links.filter(l => l !== link); checkpoint(); status = 'Провод удалён.'; render(); }
    function choosePort(node, direction, socket) {
      if (direction === 'outputs') {
        pendingPort = { node: node.id, socket, type: portType(node, direction, socket) };
        status = `Выход «${socket}» выбран. Теперь нажмите совместимый вход.`; render(); return;
      }
      if (!pendingPort) { status = 'Сначала выберите выходной порт.'; render(); return; }
      applyLink({ from: { node: pendingPort.node, socket: pendingPort.socket }, to: { node: node.id, socket } }, '');
    }
    function addFrame() {
      const members = [...selected]; if (!members.length) { status = 'Выберите узел(ы) рамки с Ctrl/⌘ + щелчок.'; render(); return; }
      graph.frames.push({ id: mkId('frame'), title: `Рамка ${graph.frames.length + 1}`, nodes: members }); checkpoint(); status = ''; render();
    }
    function makeGroup() {
      const ids = new Set(selected); if (!ids.size) { status = 'Выберите узлы, которые нужно сгруппировать.'; render(); return; }
      if (graph.nodes.some(n => ids.has(n.id) && (n.type === 'action.program' || n.type === 'flow.end'))) { status = 'Начало и конец действия нельзя поместить в группу.'; render(); return; }
      const members = graph.nodes.filter(n => ids.has(n.id));
      const incoming = graph.links.filter(l => !ids.has(l.from.node) && ids.has(l.to.node));
      const outgoing = graph.links.filter(l => ids.has(l.from.node) && !ids.has(l.to.node));
      if (incoming.length > 16 || outgoing.length > 16) { status = 'У группы может быть не более 16 входов и 16 выходов.'; render(); return; }
      const groupId = mkId('group'), instanceId = mkId('instance'), boundaryNodes = [], innerLinks = [], outerLinks = [];
      const inputs = incoming.map((link, i) => {
        const id = `in-${i + 1}`, source = nodeById(link.from.node), type = portType(source, 'outputs', link.from.socket);
        return { id, name: `Вход ${i + 1}`, type, link };
      });
      const outputs = outgoing.map((link, i) => {
        const id = `out-${i + 1}`, source = nodeById(link.from.node), type = portType(source, 'outputs', link.from.socket);
        return { id, name: `Выход ${i + 1}`, type, link };
      });
      for (const input of inputs) {
        const boundaryId = mkId('gin');
        boundaryNodes.push({ id: boundaryId, type: 'group.input', params: { socket_id: input.id }, position: { x: 0, y: 0 } });
        innerLinks.push({ from: { node: boundaryId, socket: 'value' }, to: { node: input.link.to.node, socket: input.link.to.socket } });
        outerLinks.push({ from: clone(input.link.from), to: { node: instanceId, socket: input.id } });
      }
      for (const output of outputs) {
        const boundaryId = mkId('gout');
        boundaryNodes.push({ id: boundaryId, type: 'group.output', params: { socket_id: output.id }, position: { x: 0, y: 0 } });
        innerLinks.push({ from: clone(output.link.from), to: { node: boundaryId, socket: 'value' } });
        outerLinks.push({ from: { node: instanceId, socket: output.id }, to: clone(output.link.to) });
      }
      const internalLinks = graph.links.filter(l => ids.has(l.from.node) && ids.has(l.to.node));
      const group = { id: groupId, name: `Группа ${graph.groups.length + 1}`, inputs: inputs.map(({ id, name, type }) => ({ id, name, type })), outputs: outputs.map(({ id, name, type }) => ({ id, name, type })), nodes: [...clone(members), ...boundaryNodes], links: [...clone(internalLinks), ...innerLinks], frames: [] };
      graph.groups.push(group);
      const x = Math.round(members.reduce((n, item) => n + (item.position?.x || 0), 0) / members.length), y = Math.round(members.reduce((n, item) => n + (item.position?.y || 0), 0) / members.length);
      graph.nodes = graph.nodes.filter(n => !ids.has(n.id));
      graph.links = graph.links.filter(l => !ids.has(l.from.node) && !ids.has(l.to.node));
      graph.links.push(...outerLinks);
      graph.nodes.push({ id: instanceId, type: 'group.instance', params: { group_id: groupId }, position: { x, y }, action: activeAction });
      graph.frames.forEach(frame => frame.nodes = frame.nodes.filter(id => !ids.has(id)));
      checkpoint(); selected.clear(); activeNode = instanceId; selected.add(instanceId); status = 'Группа создана с типизированными входами и выходами. Её можно повторно вставить из списка групп.'; render();
    }
    function insertGroup(group) {
      const id = mkId('instance'); graph.nodes.push({ id, type: 'group.instance', params: { group_id: group.id }, position: { x: 80 + graph.nodes.length * 28, y: 80 + graph.nodes.length * 24 }, action: activeAction });
      checkpoint(); activeNode = id; selected = new Set([id]); status = ''; render();
    }
    function moveNode(node, x, y) { node.position ||= { x: 0, y: 0 }; node.position.x = Math.max(-100000, Math.min(100000, x)); node.position.y = Math.max(-100000, Math.min(100000, y)); }
    function nodeById(id) { return graph.nodes.find(n => n.id === id); }
    // Действие: «Начало» → «Конец». Новое действие — отдельная цепочка, связей с другими действиями нет.
    function createAction() {
      const count = graph.nodes.filter(n => n.type === 'action.program').length;
      const start = { id: mkId('node'), type: 'action.program', params: { program_id: mkId('program'), name: `Действие ${count + 1}`, trigger: 'use' }, position: { x: 60, y: 70 } };
      start.action = start.id;
      const end = { id: mkId('node'), type: 'flow.end', params: {}, position: { x: 340, y: 70 }, action: start.id };
      graph.nodes.push(start, end);
      graph.links.push({ from: { node: start.id, socket: 'exec' }, to: { node: end.id, socket: 'exec' } });
      activeAction = start.id; selected = new Set([start.id]); activeNode = start.id; status = '';
      checkpoint(); render();
    }
    function switchAction(programId) {
      activeAction = programId; selected = new Set(); activeNode = ''; status = '';
      view.x = 40; view.y = 40; view.k = 1; render();
    }
    function deleteAction(programId) {
      if (typeof window.confirm === 'function' && !window.confirm('Удалить действие вместе с его узлами?')) return;
      const owners = actionOwners(graph), drop = new Set(graph.nodes.filter(n => owners.get(n.id) === programId).map(n => n.id));
      graph.nodes = graph.nodes.filter(n => !drop.has(n.id));
      graph.links = graph.links.filter(l => !drop.has(l.from.node) && !drop.has(l.to.node));
      graph.frames.forEach(f => f.nodes = f.nodes.filter(n => !drop.has(n)));
      activeAction = ''; selected = new Set(); activeNode = ''; status = '';
      checkpoint(); render();
    }
    function deleteNodes(ids) {
      // Начало действия удаляется только вместе с действием (кнопка «Удалить действие»).
      if (ids.some(id => nodeById(id)?.type === 'action.program')) { status = 'Начало действия удаляется кнопкой «Удалить действие».'; ids = ids.filter(id => nodeById(id)?.type !== 'action.program'); }
      if (!ids.length) { render(); return; }
      const droppedEnd = ids.some(id => nodeById(id)?.type === 'flow.end');
      const drop = new Set(ids);
      graph.nodes = graph.nodes.filter(n => !drop.has(n.id));
      graph.links = graph.links.filter(l => !drop.has(l.from.node) && !drop.has(l.to.node));
      graph.frames.forEach(f => f.nodes = f.nodes.filter(n => !drop.has(n)));
      selected = new Set([...selected].filter(id => !drop.has(id)));
      if (drop.has(activeNode)) activeNode = '';
      // Действие без «Конца» сохраняется, но не исполняется: говорим об этом сразу.
      if (droppedEnd) {
        const message = '«Конец» удалён: действие осталось без «Конца», граф не исполняется.';
        status = message; window.toast?.(message);
      }
      checkpoint(); render();
    }
    let menuHandle = null;
    function openMenu(clientX, clientY, options) {
      menuHandle?.close(); menuHandle = null;
      const container = canvasEl(), rect = canvasRect();
      if (!container || !window.NodeMenu) return;
      menuHandle = window.NodeMenu.open({ container, x: clientX - rect.left, y: clientY - rect.top, onClose: () => { menuHandle = null; }, ...options });
    }
    // Короткие параметры узла прямо на карточке. Жесты полей изолированы: pointer и click не доходят до карточки
    // (нет перетаскивания, нет повторной отрисовки при фокусе), сокеты и провода — отдельные элементы вне этой панели.
    // Значение записывается в граф на change (уход из поля или Enter), как и в боковой панели.
    function inlineParams(node) {
      const groups = graph.groups.map(item => ({ value: item.id, label: item.name }));
      // Источник data.result — программы этого графа (в паре с «последним действием»).
      const programs = graph.nodes.filter(item => item.type === 'action.program')
        .map(item => ({ value: String(item.params?.program_id || item.id), label: String(item.params?.name || item.params?.program_id || item.id) }));
      const form = NodeForm.nodeParams(node, { inline: false, groups, programs, onChange: next => { node.params = next; checkpoint(); status = ''; render(); } });
      return el('div', { class: 'node-inline', 'data-inline-params': node.id, onpointerdown: e => e.stopPropagation(), onclick: e => e.stopPropagation() }, form);
    }
    function nodeCard(node) {
      const pos = node.position || { x: 0, y: 0 }, group = node.type === 'group.instance' ? graph.groups.find(g => g.id === node.params?.group_id) : null;
      const groups = new Map(graph.groups.map(g => [g.id, g]));
      const inputs = socketMap(node, groups).inputs, outputs = socketMap(node, groups).outputs;
      // Категория реестра задаёт цвет полоски и шапки карточки (классы cat-* в style.css).
      const category = NodeRegistry.categoryOf(node.type)?.id || 'other', label = group?.name || nodeLabel(node.type, node.params);
      const socket = (direction, name, type) => el('button', { class: `node-socket ${direction === 'inputs' ? 'in' : 'out'} socket-${type}`, title: `${portLabel(node, direction, name)} · ${type}`,
        'data-dir': direction, 'data-node': node.id, 'data-socket': name, 'data-type': type,
        onpointerdown: e => startWire(e, node, name, direction), onclick: e => { e.stopPropagation(); choosePort(node, direction, name); } },
        direction === 'inputs' ? [el('i'), el('span', { class: 'node-socket-label' }, portLabel(node, direction, name))] : [el('span', { class: 'node-socket-label' }, portLabel(node, direction, name)), el('i')]);
      const sockets = el('div', { class: 'node-sockets' }, el('div', { class: 'node-inputs' }, ...Object.entries(inputs).map(([name, type]) => socket('inputs', name, type))),
        el('div', { class: 'node-outputs' }, ...Object.entries(outputs).map(([name, type]) => socket('outputs', name, type))));
      const card = el('article', { class: `graph-node cat-${category}` + (selected.has(node.id) ? ' selected' : ''), style: `left:${pos.x}px;top:${pos.y}px`, 'data-node-id': node.id, 'data-category': category,
        // Наведение подсвечивает всю цепочку (входы и выходы), как «flow» в Blender.
        onpointerenter: () => highlightFlow(node.id), onpointerleave: () => highlightFlow(''),
        // Перетаскивание — за любую часть карточки, кроме кнопок, полей и сокетов (у них свои жесты).
        onpointerdown: e => { suppressClick = false; if (e.target?.closest?.('button, input, select, textarea')) return; startDrag(e, node); },
        onclick: e => { if (suppressClick) { suppressClick = false; return; } activeNode = node.id; if (e.ctrlKey || e.metaKey || e.shiftKey) { if (selected.has(node.id)) selected.delete(node.id); else selected.add(node.id); } else selected = new Set([node.id]); render(); },
        oncontextmenu: e => { e.preventDefault(); e.stopPropagation(); if (!selected.has(node.id)) { selected = new Set([node.id]); activeNode = node.id; render(); } openMenu(e.clientX, e.clientY, { categories: true, sections: [
          { title: 'Узел', items: [
            { label: 'Дублировать', run: () => ({ action: 'duplicate' }) },
            { label: 'Удалить выделенное', run: () => ({ action: 'delete' }) }] },
          { title: 'Группа', items: [
            { label: 'Сгруппировать выделенное', run: () => ({ action: 'group' }) },
            { label: 'Рамка из выделения', run: () => ({ action: 'frame' }) }] },
          { title: 'Добавить рядом', items: window.NodeMenu.catalogCategories().map(cat => ({ label: cat.label, children: cat.children.map(c => ({ ...c, run: () => ({ action: 'add', type: c.hint, at: { x: node.position.x + 280, y: node.position.y } }) })) })) },
        ],
          onPick: r => { if (r.action === 'delete') deleteNodes([...selected]); else if (r.action === 'group') makeGroup(); else if (r.action === 'duplicate') duplicateNodes([...selected]); else if (r.action === 'add') addNode(r.type, null, r.at); else addFrame(); } }); } },
        // Шапка как в Blender: цвет категории, имя узла и компактный id; ниже — список портов, затем поля.
        el('header', { class: 'graph-node-head' },
          el('span', { class: 'node-dot' }), el('b', { title: [node.type, NodeRegistry.nodeDef(node.type)?.description].filter(Boolean).join(' · ') }, label),
          el('span', { class: 'node-id', title: node.id }, node.id.slice(0, 14)),
          el('button', { class: 'node-delete', title: 'Удалить узел', onclick: e => { e.stopPropagation(); deleteNodes([node.id]); } }, '×')),
        sockets,
        el('div', { class: 'node-body' }, inlineParams(node), groupExtras(node), nodeRaw(node)));
      return card;
    }
    // Точка провода в мировых координатах: центр кружка сокета из DOM (зум и панорама учитываются),
    // а если узел ещё не на экране (до первого показа) — оценка по позиции карточки.
    function socketAnchor(nodeId, direction, socketName, rect = null) {
      const node = nodeById(nodeId), pos = node?.position || { x: 0, y: 0 };
      const fallback = { x: pos.x + (direction === 'outputs' ? 224 : 0), y: pos.y + 56 };
      const socketEl = root.querySelector?.(`.node-socket[data-node="${nodeId}"][data-dir="${direction}"][data-socket="${socketName}"]`);
      return (socketEl && socketDotAnchor(socketEl, rect || canvasRect())) || fallback;
    }
    const anchorKey = (nodeId, direction, socketName) => `${nodeId}:${direction}:${socketName}`;
    const fallbackAnchor = (nodeId, direction) => { const pos = nodeById(nodeId)?.position || { x: 0, y: 0 }; return { x: pos.x + (direction === 'outputs' ? 224 : 0), y: pos.y + 56 }; };
    // Точки всех сокетов на одну перерисовку: DOM-запрос и геометрия читаются по разу на сокет,
    // а не на каждый провод. Иначе каждый провод вызывает layout-чтение и перерисовка «дёргается».
    function socketAnchorCache(rect) {
      const cache = new Map();
      for (const socketEl of root.querySelectorAll?.('.node-socket') || []) {
        const point = socketDotAnchor(socketEl, rect);
        if (point) cache.set(anchorKey(socketEl.dataset.node, socketEl.dataset.dir, socketEl.dataset.socket), point);
      }
      return cache;
    }
    // Подсветка цепочки: от узла вверх и вниз по проводам (как «flow» в Blender).
    function highlightFlow(nodeId) {
      const nodes = new Set(), wires = new Set();
      if (nodeId) {
        const walk = (start, forward) => {
          const queue = [start], seen = new Set([start]);
          while (queue.length) {
            for (const link of graph.links) {
              const id = queue[0];
              const near = forward ? link.from.node : link.to.node, far = forward ? link.to.node : link.from.node;
              if (near !== id || seen.has(far)) continue;
              seen.add(far); nodes.add(far); queue.push(far);
              wires.add(`${link.from.node}.${link.from.socket}>${link.to.node}.${link.to.socket}`);
            }
            nodes.add(queue.shift());
          }
        };
        walk(nodeId, true); walk(nodeId, false);
      }
      canvasEl()?.classList.toggle('flow', Boolean(nodeId));
      for (const card of root.querySelectorAll?.('.graph-node') || []) card.classList.toggle('flow-node', nodes.has(card.dataset.nodeId));
      for (const path of root.querySelectorAll?.('.node-wire') || []) path.classList.toggle('flow-wire', wires.has(path.dataset.link));
    }
    function drawWires(canvas) {
      if (!document.createElementNS) return;
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'node-wires'); svg.setAttribute('aria-hidden', 'true');
      // Прямоугольник холста читается один раз на перерисовку, а не для каждой точки провода.
      const rect = canvasRect();
      const anchors = socketAnchorCache(rect);
      const point = (nodeId, direction, socketName) => anchors.get(anchorKey(nodeId, direction, socketName)) || fallbackAnchor(nodeId, direction);
      for (const link of graph.links.filter(l => shownIds.has(l.from.node) && shownIds.has(l.to.node))) {
        const a = nodeById(link.from.node), b = nodeById(link.to.node); if (!a || !b) continue;
        const type = portType(a, 'outputs', link.from.socket) || 'flow';
        const from = point(a.id, 'outputs', link.from.socket), to = point(b.id, 'inputs', link.to.socket);
        const d = wireCurve(from.x, from.y, to.x, to.y), name = `${link.from.node}.${link.from.socket}>${link.to.node}.${link.to.socket}`;
        // Невидимая широкая зона попадания (клик удаляет провод) и тонкая видимая линия поверх неё.
        const hit = document.createElementNS(NS, 'path');
        hit.setAttribute('d', d); hit.setAttribute('class', 'node-wire-hit'); hit.setAttribute('data-link-hit', name);
        hit.addEventListener('click', e => { e.stopPropagation(); removeLink(link); });
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('data-link', name);
        path.setAttribute('class', `node-wire socket-${type}`);
        svg.append(hit, path);
      }
      // Превью-путь создаётся один раз за жест; дальше updateWireDrag меняет только его атрибут d.
      let preview = null;
      if (wire) {
        const a = nodeById(wire.node); if (a) {
          const origin = socketAnchor(a.id, wire.direction, wire.socket, rect);
          preview = document.createElementNS(NS, 'path');
          preview.setAttribute('d', wire.direction === 'outputs' ? wireCurve(origin.x, origin.y, wire.x, wire.y) : wireCurve(wire.x, wire.y, origin.x, origin.y));
          preview.setAttribute('class', `node-wire node-wire-preview socket-${wire.type}`);
          svg.appendChild(preview);
        }
      }
      canvas.appendChild(svg);
      wirePreview = preview;
    }
    // Группа на карточке: имя и список входов/выходов (остальные параметры — в полях карточки).
    function groupExtras(node) {
      const group = node.type === 'group.instance' ? graph.groups.find(item => item.id === node.params?.group_id) : null;
      if (!group) return null;
      const stop = { onpointerdown: e => e.stopPropagation(), onclick: e => e.stopPropagation() };
      return el('div', { class: 'node-group-details', ...stop },
        field('Имя группы', el('input', { value: group.name, onchange: e => { group.name = String(e.target.value).slice(0, 120) || group.name; checkpoint(); render(); } })),
        el('p', { class: 'muted small' }, `Входы: ${(group.inputs || []).map(item => `${item.name} · ${item.type}`).join(', ') || 'нет'}`),
        el('p', { class: 'muted small' }, `Выходы: ${(group.outputs || []).map(item => `${item.name} · ${item.type}`).join(', ') || 'нет'}`));
    }
    // JSON параметров для разработчиков — свёрнут внизу карточки.
    function nodeRaw(node) {
      const raw = el('textarea', { class: 'node-params', spellcheck: 'false', 'aria-label': 'JSON параметров узла', onfocus: () => { raw.value = JSON.stringify(node.params || {}, null, 2); }, onchange: () => {
        try { const next = JSON.parse(raw.value); if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('Параметры должны быть JSON-объектом.'); node.params = next; checkpoint(); status = ''; render(); }
        catch (e) { status = e.message; render(); }
      } }, JSON.stringify(node.params || {}, null, 2));
      return el('details', { class: 'node-raw', onpointerdown: e => e.stopPropagation(), onclick: e => e.stopPropagation() }, el('summary', {}, 'JSON'), raw);
    }
    function renderPreview() {
      const out = el('pre', { class: 'node-preview-output' });
      const draw = () => { const data = previewGraph(mechanics, currentEdition, currentLevel, currentChoices, currentSubclass); out.textContent = JSON.stringify(data, null, 2); };
      const edition = el('select', { value: currentEdition, onchange: e => { currentEdition = e.target.value; draw(); } }, ...['2014', '2024'].map(x => el('option', { value: x, selected: x === currentEdition ? '' : null }, `SRD ${x}`)));
      const level = el('input', { type: 'number', min: 1, max: 20, value: currentLevel, onchange: e => { currentLevel = Math.max(1, Math.min(20, Number(e.target.value) || 1)); draw(); } });
      const subclass = el('input', { value: currentSubclass, placeholder: 'ID подкласса', oninput: e => { currentSubclass = e.target.value; draw(); } });
      const choices = NodeForm.valueEditor(currentChoices, { ariaLabel: 'Выборы для предпросмотра', onChange: next => { currentChoices = next; draw(); } });
      draw();
      return el('details', { class: 'node-preview', open: '' }, el('summary', {}, 'Предпросмотр графа · без сохранения'), el('div', { class: 'row' }, field('Редакция', edition), field('Уровень', level), field('Подкласс ID', subclass)), el('div', { class: 'node-field' }, el('span', {}, 'Выборы по ID'), choices), out);
    }
    function render() {
      // Редактор переназначает массивы графа (links, nodes); записываем актуальный граф в документ до каждого показа.
      doc.mechanics.graph = graph;
      shell.replaceChildren();
      // Показываем одно действие: его узлы, его связи и кнопки переключения между действиями.
      const starts = graph.nodes.filter(n => n.type === 'action.program');
      if (!starts.some(n => n.id === activeAction)) activeAction = starts[0]?.id || '';
      const owners = actionOwners(graph);
      const shown = graph.nodes.filter(n => owners.get(n.id) === activeAction);
      shownIds = new Set(shown.map(n => n.id));
      const actionBar = el('div', { class: 'node-actions', role: 'tablist', 'aria-label': 'Действия' }, ...[
        ...starts.map(n => el('button', { class: 'small node-action-tab' + (n.id === activeAction ? ' active' : ''), role: 'tab', 'aria-selected': n.id === activeAction ? 'true' : 'false', 'data-action-tab': n.id, onclick: () => switchAction(n.id) }, n.params?.name || 'Действие')),
        el('button', { class: 'small', 'data-action': 'new-action', onclick: createAction }, '+ Действие'),
        activeAction ? el('button', { class: 'small danger', 'data-action': 'delete-action', onclick: () => deleteAction(activeAction) }, 'Удалить действие') : null,
        starts.length ? null : el('span', { class: 'muted small' }, 'Действий пока нет. У каждого действия есть начало и конец, блоки ставятся между ними.'),
      ].filter(Boolean));
      const searchBox = el('input', { class: 'node-search', value: search, placeholder: 'Найти узел…  Shift+A', 'aria-label': 'Поиск узла', oninput: e => { search = e.target.value; render(); root.querySelector?.('.node-search')?.focus?.(); } });
      const query = search.toLocaleLowerCase();
      const palette = Object.entries(NODE_DEFS).filter(([type, def]) => !['group.input', 'group.output'].includes(type) && (!query || `${type} ${def.label} ${def.description || ''} ${def.group}`.toLocaleLowerCase().includes(query)));
      const shownPalette = query ? palette.slice(0, 8) : QUICK_NODES.filter(t => NODE_DEFS[t]).map(t => [t, NODE_DEFS[t]]);
      const toolbar = el('div', { class: 'node-toolbar' }, field('Поиск / добавить узел', searchBox), ...shownPalette.map(([type, def]) => el('button', { class: 'small node-add', title: type, 'data-description': def.description || '', onclick: () => addNode(type) }, '+ ', def.label)),
        el('button', { class: 'small', disabled: historyIndex <= 0 ? '' : null, onclick: () => restore(historyIndex - 1) }, '↶ Отменить'),
        el('button', { class: 'small', disabled: historyIndex >= history.length - 1 ? '' : null, onclick: () => restore(historyIndex + 1) }, '↷ Повторить'),
        el('button', { class: 'small', onclick: addFrame }, '+ Рамка'), el('button', { class: 'small', onclick: makeGroup }, 'Сгруппировать'),
        el('button', { class: 'small', 'data-action': 'presets', onclick: () => window.Presets?.openManager() }, 'Наборы данных…'),
        el('span', { class: 'muted small' }, 'ПКМ — меню узлов · колесо — масштаб · средняя кнопка — панорама · рамка — выделение'));
      // Пустой граф: сразу предлагаем готовые варианты, чтобы не начинать с чистого холста.
      const starters = !isBlankAction() || !graphStarters().length ? null : el('div', { class: 'node-starters' },
        el('b', {}, 'Начните с готового графа'),
        el('span', { class: 'muted small' }, 'Вариант можно поменять в любой момент. Или добавьте узел кнопкой выше или через ПКМ по холсту.'),
        ...graphStarters().map(s => el('button', { class: 'small', title: s.hint, 'data-starter': s.id, onclick: () => insertStarter(s) }, s.name)));
      // Компактная панель шаблонов: всё остальное — в диалоге (готовые, свои и группы).
      const templateBar = el('div', { class: 'node-template-bar' },
        el('button', { class: 'primary', type: 'button', 'data-action': 'templates-dialog', onclick: () => openTemplatesDialog('browse') }, 'Шаблоны действий'),
        el('button', { class: 'small', type: 'button', 'data-action': 'save-template', onclick: () => openTemplatesDialog('save') }, 'Сохранить как шаблон'),
        el('span', { class: 'node-template-hint muted small' }, 'Готовые наборы, свои цепочки и группы'));
      const groupShelf = graph.groups.length || groupTemplates().length ? el('div', { class: 'node-group-shelf' },
        graph.groups.length ? el('b', {}, 'Группы') : null,
        ...graph.groups.map(g => el('span', { class: 'node-group-item' },
          el('button', { class: 'small', onclick: () => insertGroup(g) }, 'Вставить: ', g.name),
          el('button', { class: 'small', title: 'Сохранить группу в шаблоны', onclick: () => saveGroupTemplate(g) }, 'В шаблоны'))),
        groupTemplates().length ? el('b', {}, 'Шаблоны групп') : null,
        ...groupTemplates().map(t => el('span', { class: 'node-group-item' },
          el('button', { class: 'small', onclick: () => insertGroupTemplate(t) }, 'Вставить: ', t.name),
          el('button', { class: 'small', title: 'Удалить шаблон группы', onclick: () => removeGroupTemplate(t.id) }, '×')))) : null;
      const frames = graph.frames.map(f => {
        const members = f.nodes.map(nodeById).filter(n => n && shownIds.has(n.id)); if (!members.length) return null;
        const left = Math.min(...members.map(n => n.position?.x || 0)) - 16, top = Math.min(...members.map(n => n.position?.y || 0)) - 34;
        return el('div', { class: 'node-frame', style: `left:${left}px;top:${top}px;width:${Math.max(230, ...members.map(n => (n.position?.x || 0) - left + 230))}px;height:${Math.max(100, ...members.map(n => (n.position?.y || 0) - top + 120))}px` }, el('b', {}, f.title));
      });
      const world = el('div', { class: 'node-world', style: `transform: translate(${view.x}px, ${view.y}px) scale(${view.k})` }, ...frames, ...shown.map(nodeCard));
      const canvas = el('div', { class: 'node-canvas', 'data-zoom': view.k.toFixed(2),
        onwheel: e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1); },
        onpointerdown: e => {
          if (e.button === 1) { e.preventDefault(); startPan(e); return; }
          if (e.button !== 0 || e.target.closest?.('.graph-node, button, input, select, textarea, .node-menu, .node-wires')) return;
          startMarquee(e);
        },
        onauxclick: e => e.preventDefault(),
        oncontextmenu: e => { e.preventDefault(); const at = worldPoint(e.clientX, e.clientY); openMenu(e.clientX, e.clientY, { searchable: true, categories: true, sections: q => window.NodeMenu.addSections(q), onPick: r => addNode(r.type, null, { x: Math.round(at.x), y: Math.round(at.y) }) }); } }, world);
      // Незавершённость графа (например, «Если» без условия) показываем сразу, но не блокируем связи:
      // блокируют только ошибки, которые создаёт сама новая связь (см. connectionError). Полная проверка — при сохранении.
      const pending = graphProblems(graph, graph.groups || []);
      const statusLine = el('div', { class: 'node-status' + (pending.length && !status ? ' warn' : ''), role: 'status' }, status || (pending.length ? `Граф не исполняется, пока не исправлено: ${pending.join('; ')}` : ''));
      // Пустые части (нет групп) не добавляем: null в append превращается в текст «null».
      shell.append(...[actionBar, toolbar, starters, groupShelf, el('div', { class: 'node-workspace' }, canvas), templateBar, statusLine, renderPreview()].filter(Boolean));
      // Если редактор перерисовали при открытом диалоге, окно остаётся поверх оболочки.
      if (tpl.open && tpl.overlay && !tpl.overlay.isConnected) root.append(tpl.overlay);
      // Провода рисуются после вставки карточек: точки сокетов измеряются по DOM.
      drawWires(world);
      // Сетка холста выравнивается по текущему виду (applyView только двигает фон и transform).
      applyView();
      // Keep status reference in a closure-safe property for JSON validation errors.
      root._statusNode = statusLine;
      // Сокеты измеряются по DOM. При первом показе редактор ещё не в документе: провода пересчитываются в следующем кадре.
      // Если редактор уже на странице, провода измерены сразу (без отложенной перерисовки, которая могла бы заменить элемент под курсором).
      if (!root.isConnected) requestAnimationFrame?.(() => refreshWires());
    }
    root.addEventListener('keydown', e => {
      const typing = e.target?.closest?.('input, textarea, select');
      if (e.shiftKey && String(e.key).toLowerCase() === 'a') { e.preventDefault(); const input = root.querySelector?.('.node-search'); input?.focus?.(); input?.select?.(); }
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'z') { e.preventDefault(); restore(e.shiftKey ? historyIndex + 1 : historyIndex - 1); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && selected.size) { e.preventDefault(); deleteNodes([...selected]); }
      if (e.key === 'Escape') { pendingPort = null; wire = null; status = ''; closeMenuSafe(); render(); }
    });
    function closeMenuSafe() { menuHandle?.close(); menuHandle = null; }
    // Validation and cancel are controlled by the enclosing record modal.
    mechanics = graphEnvelope(graph, Object.fromEntries(Object.entries(mechanics).filter(([k]) => k !== 'version' && k !== 'graph')));
    doc.mechanics = mechanics;
    render();
    return root;
  }

  const oldButtons = Base.buttons, oldPreview = Base.preview, oldProgramsOf = Base.programsOf, oldPassiveData = Base.passiveData;
  function runtimeContext(context = {}) {
    const sheet = window.SHEET_CTX || {};
    return { edition: context.edition ?? window.SHEET_EDITION ?? sheet.edition ?? '2014', level: context.level ?? sheet.level ?? 1,
      subclass: context.subclass ?? sheet.subclass ?? '', choices: context.choices ?? sheet.creation?.rule_choices ?? {} };
  }
  const API = {
    ...Base,
    VERSION: GRAPH_VERSION,
    GRAPH_VERSION,
    NODE_DEFS,
    nodeLabel,
    toLegacy: v2ToV1,
    validateGraph,
    problems,
    graphProblems,
    addFlowEnds,
    connectionError,
    wouldCycle,
    graphPreview: previewGraph,
    evaluateGraph,
    // Таблица развития класса из узла rule.class (kind: class_progression) с учётом редакции; null, если узла нет.
    classProgression(mechanics, edition = '2014') {
      if (mechanics?.version !== GRAPH_VERSION) return null;
      const result = evaluateGraph(mechanics, { edition: String(edition), level: 1 });
      return result.error ? null : (result.sheet?.class_progression || null);
    },
    // Правила класса из узла rule.class (kind: class_rules; кастеры, мультикласс, мастерства оружия); null, если узла нет.
    classRules(mechanics, edition = '2014') {
      if (mechanics?.version !== GRAPH_VERSION) return null;
      const result = evaluateGraph(mechanics, { edition: String(edition), level: 1 });
      return result.error ? null : (result.sheet?.class_rules || null);
    },
    // Стартовое снаряжение из графа: rule.list (kind: equipment) и rule.list (kind: equipment_choice).
    equipment(mechanics, options = {}) {
      if (mechanics?.version !== GRAPH_VERSION) return { items: [], choices: [] };
      const result = evaluateGraph(mechanics, options);
      if (result.error) return { items: [], choices: [] };
      const items = result.effects.filter(e => e.kind === 'equipment').flatMap(e => e.items || []);
      const choices = result.effects.filter(e => e.kind === 'equipment_choice').map(e => ({ id: e.id, title: e.title, options: e.options || [] }));
      return { items, choices };
    },
    // Умения класса по уровням из узла rule.list (kind: class_features); null, если узла нет.
    classFeatures(mechanics, edition = '2014') {
      if (mechanics?.version !== GRAPH_VERSION) return null;
      const result = evaluateGraph(mechanics, { edition: String(edition), level: 1 });
      return result.error ? null : (result.sheet?.class_features || null);
    },
    // Выбор навыков из узла rule.list (kind: skills, params {id, count, options}) — для классов id «classSkills»;
    // null, если узла нет. Пустой список — «любой навык», как у расс.
    classSkills(mechanics, edition = '2014') {
      if (mechanics?.version !== GRAPH_VERSION) return null;
      const result = evaluateGraph(mechanics, { edition: String(edition), level: 1 });
      if (result.error) return null;
      const rules = result.sheet?.skill_choices || [];
      const node = rules.find(r => r.id === 'classSkills') || rules[0];
      return node ? { id: node.id, count: Math.max(0, Number(node.count) || 0), options: (node.options || []).map(String) } : null;
    },
    // Заклинательная характеристика из узла rule.class (kind: spellcasting); null, если узла нет.
    classSpellcasting(mechanics, edition = '2014') {
      if (mechanics?.version !== GRAPH_VERSION) return null;
      const result = evaluateGraph(mechanics, { edition: String(edition), level: 1 });
      return result.error ? null : (result.sheet?.spellcasting || null);
    },
    applyGraphRules,
    validate,
    programsOf(mechanics, context) { return mechanics?.version === GRAPH_VERSION ? Base.programsOf(v2ToV1(mechanics, runtimeContext(context))) : oldProgramsOf(mechanics); },
    // Запись без механик: особенности черт читаются у каждой записи, отсутствие механик — это «ничего нет».
    forFeature(mechanics, name) {
      if (mechanics?.version !== GRAPH_VERSION) return undefined;
      return mechanicsForFeature(mechanics, name);
    },
    passiveData(entry, context) {
      const e = clone(entry), original = e.data?.mechanics;
      if (original?.version === GRAPH_VERSION) {
        const plan = v2ToV1(original, runtimeContext(context)); const projected = oldPassiveData({ ...e, data: { ...e.data, mechanics: plan } });
        projected.data.mechanics = original; return projected;
      }
      return oldPassiveData(e);
    },
    preview(mechanics, ctx) { return oldPreview(v2ToV1(mechanics, runtimeContext(ctx)), ctx); },
    buttons(doc, options = {}) { return oldButtons({ ...doc, mechanics: v2ToV1(doc.mechanics, runtimeContext(options.context)) }, options); },
    editor: graphEditor,
    actionOwners,
    connectionError,
  };
  window.Mechanics = API;
})();
