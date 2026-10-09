// ---------------------------------------------------------------------------
// mechanics-graph.js — схема механик v2: типизированный ациклический граф,
// адаптер block-v1, декларативное исполнение правил и визуальный редактор.
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
  const ACTION_KINDS = ['consume', 'attack', 'damage', 'heal', 'temp_hp', 'roll', 'grant_item', 'condition', 'adjust', 'require', 'manual', 'passive'];
  const VALUE_TYPES = ['flow', 'bool', 'number', 'dice', 'ability', 'text', 'list', 'table', 'choice', 'effect'];
  const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
  const NODE_DEFS = {
    'data.number': { label: 'Число', group: 'Данные', inputs: {}, outputs: { value: 'number' }, defaults: { value: 1 } },
    'data.dice': { label: 'Кость', group: 'Данные', inputs: {}, outputs: { value: 'dice' }, defaults: { value: { count: 1, sides: 6, bonus: 0, stat: '' } } },
    'data.ability': { label: 'Характеристика', group: 'Данные', inputs: {}, outputs: { value: 'ability' }, defaults: { value: 'str' } },
    'data.table': { label: 'Таблица по уровню', group: 'Данные', inputs: {}, outputs: { value: 'table' }, defaults: { value: {} } },
    'data.choice': { label: 'Выбор', group: 'Данные', inputs: {}, outputs: { value: 'choice' }, defaults: { value: { id: '', count: 1, options: [] } } },
    'data.text': { label: 'Текст', group: 'Данные', inputs: {}, outputs: { value: 'text' }, defaults: { value: '' } },
    'condition.edition': { label: 'Если редакция', group: 'Условия', inputs: {}, outputs: { value: 'bool' }, defaults: { editions: ['2014'] } },
    'condition.level': { label: 'Если уровень', group: 'Условия', inputs: {}, outputs: { value: 'bool' }, defaults: { min: 1, max: 20 } },
    'condition.subclass': { label: 'Если подкласс', group: 'Условия', inputs: {}, outputs: { value: 'bool' }, defaults: { id: '' } },
    'condition.choice': { label: 'Если выбран вариант', group: 'Условия', inputs: {}, outputs: { value: 'bool' }, defaults: { id: '', value: '' } },
    'flow.if': { label: 'Если', group: 'Поток', inputs: { exec: 'flow', condition: 'bool' }, outputs: { then: 'flow', else: 'flow' }, defaults: {} },
    'rule.ability_bonus': { label: 'Бонус характеристики', group: 'Правила персонажа', inputs: { enabled: 'bool', amount: 'number' }, outputs: { effect: 'effect' }, defaults: { ability: 'str', amount: 1 } },
    'rule.speed': { label: 'Скорость', group: 'Правила персонажа', inputs: { enabled: 'bool', value: 'number' }, outputs: { effect: 'effect' }, defaults: { value: 30 } },
    'rule.languages': { label: 'Языки', group: 'Правила персонажа', inputs: { enabled: 'bool', value: 'list' }, outputs: { effect: 'effect' }, defaults: { value: [] } },
    'rule.proficiencies': { label: 'Владения', group: 'Правила персонажа', inputs: { enabled: 'bool', value: 'list' }, outputs: { effect: 'effect' }, defaults: { kind: 'general', value: [] } },
    'rule.hit_die': { label: 'Кость хитов', group: 'Правила персонажа', inputs: { enabled: 'bool', value: 'text' }, outputs: { effect: 'effect' }, defaults: { value: 'd8' } },
    'rule.saving_throws': { label: 'Спасброски', group: 'Правила персонажа', inputs: { enabled: 'bool', value: 'list' }, outputs: { effect: 'effect' }, defaults: { value: [] } },
    'rule.feature': { label: 'Умение', group: 'Правила персонажа', inputs: { enabled: 'bool' }, outputs: { effect: 'effect' }, defaults: { name: 'Новое умение', text: '', feature_name: '' } },
    'rule.skills': { label: 'Выбор навыков', group: 'Правила персонажа', inputs: { enabled: 'bool', options: 'list', count: 'number' }, outputs: { effect: 'effect' }, defaults: { id: '', count: 1, options: [] } },
    'rule.spell_list': { label: 'Список заклинаний', group: 'Правила персонажа', inputs: { enabled: 'bool', spells: 'list' }, outputs: { effect: 'effect' }, defaults: { mode: 'known', ability: 'int', spells: [] } },
    'rule.spell_slots': { label: 'Ячейки заклинаний', group: 'Правила персонажа', inputs: { enabled: 'bool', table: 'table' }, outputs: { effect: 'effect' }, defaults: { table: {} } },
    'rule.asi': { label: 'Улучшение характеристик', group: 'Правила персонажа', inputs: { enabled: 'bool', table: 'table' }, outputs: { effect: 'effect' }, defaults: { table: {} } },
    'rule.class_progression': { label: 'Прогрессия класса', group: 'Правила персонажа', inputs: { enabled: 'bool', table: 'table' }, outputs: { effect: 'effect' }, defaults: { table: {} } },
    'rule.armor_formula': { label: 'Защита без доспехов', group: 'Правила персонажа', inputs: { enabled: 'bool', formula: 'text' }, outputs: { effect: 'effect' }, defaults: { formula: '10 + @dex + @con', name: 'Защита без доспехов', no_shield: false } },
    'rule.hp_bonus': { label: 'Бонус хитов', group: 'Правила персонажа', inputs: { enabled: 'bool', amount: 'number' }, outputs: { effect: 'effect' }, defaults: { amount: 1 } },
    'rule.manual': { label: 'Ручное правило', group: 'Правила персонажа', inputs: { enabled: 'bool', text: 'text' }, outputs: { effect: 'effect' }, defaults: { text: 'Опишите правило, которое применяется вручную.' } },
    'action.program': { label: 'Действие / программа', group: 'Действия', inputs: {}, outputs: { exec: 'flow' }, defaults: { program_id: '', name: 'Новое действие', trigger: 'use' } },
    'group.instance': { label: 'Группа', group: 'Группы', inputs: {}, outputs: {}, defaults: { group_id: '' } },
    'group.input': { label: 'Вход группы', group: 'Группы', inputs: {}, outputs: { value: 'text' }, defaults: { socket_id: '' } },
    'group.output': { label: 'Выход группы', group: 'Группы', inputs: { value: 'text' }, outputs: {}, defaults: { socket_id: '' } },
  };
  for (const kind of ACTION_KINDS) {
    NODE_DEFS[`action.${kind}`] = {
      label: Base.TYPES[kind]?.[0] || kind, group: 'Действия',
      inputs: { exec: 'flow', enabled: 'bool' }, outputs: { exec: 'flow' }, defaults: actionDefaults(kind),
    };
  }
  function actionDefaults(kind) {
    const base = { enabled: true, when: 'always' };
    if (['attack', 'damage', 'heal', 'temp_hp', 'roll'].includes(kind)) base.dice = Base.dice(kind === 'attack' ? '1d20+@atk' : '1d6');
    if (kind === 'consume') Object.assign(base, { resource: 'quantity', source: 'self', amount: 1, trigger: 'use' });
    if (kind === 'manual') base.text = 'Опишите правило, которое мастер применяет вручную.';
    if (kind === 'passive') Object.assign(base, { field: 'speed', value: 30 });
    if (kind === 'condition') Object.assign(base, { condition: 'Отравленный', operation: 'add' });
    if (kind === 'adjust') Object.assign(base, { field: 'speed', amount: 5 });
    if (kind === 'require') Object.assign(base, { field: 'hp.current', minimum: 1 });
    if (kind === 'grant_item') Object.assign(base, { amount: 1, item: { name: 'Пустой флакон', type: 'gear', qty: 1 } });
    return base;
  }
  const nodeLabel = type => NODE_DEFS[type]?.label || type;
  const mkId = prefix => `${prefix}-${(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)}`;
  const stableHash = value => { let hash = 2166136261; for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(36); };
  const actionType = type => type.startsWith('action.') && (ACTION_KINDS.includes(type.slice(7)));

  function graphOf(mechanics) { return mechanics?.graph || { nodes: [], links: [], frames: [], groups: [] }; }
  function graphEnvelope(graph, metadata = {}) {
    return { ...metadata, version: GRAPH_VERSION, graph: {
      nodes: Array.isArray(graph?.nodes) ? graph.nodes : [], links: Array.isArray(graph?.links) ? graph.links : [],
      frames: Array.isArray(graph?.frames) ? graph.frames : [], groups: Array.isArray(graph?.groups) ? graph.groups : [],
    } };
  }
  function v1ToV2(mechanics) {
    if (!mechanics) return graphEnvelope({});
    if (mechanics.version === GRAPH_VERSION) return clone(mechanics);
    if (mechanics.version !== 1) return clone(mechanics);
    const v1 = Base.normalize(clone(mechanics));
    const nodes = [], links = [];
    let y = 70;
    for (const [programIndex, p] of (v1.programs || []).entries()) {
      const programKey = String(p.id || programIndex + 1);
      const programNodeId = `program-${stableHash(programKey)}`;
      nodes.push({ id: programNodeId, type: 'action.program', params: {
        program_id: p.id || mkId('p'), name: p.name || 'Действие', trigger: p.trigger || 'use',
        ...(p.feature_name ? { feature_name: p.feature_name } : {}), ...(p.group ? { group: p.group } : {}), ...(p.roll_only ? { roll_only: true } : {}),
      }, position: { x: 60, y } });
      let previous = programNodeId, x = 330, blockIndex = 0;
      for (const b of p.blocks || []) {
        const kind = b.kind === 'save' ? 'roll' : b.kind;
        if (!ACTION_KINDS.includes(kind)) continue;
        const id = `action-${stableHash(programKey)}-${++blockIndex}`;
        const params = { ...clone(b), block_id: b.id || mkId('b') };
        delete params.id; delete params.kind;
        nodes.push({ id, type: `action.${kind}`, params, position: { x, y } });
        links.push({ from: { node: previous, socket: 'exec' }, to: { node: id, socket: 'exec' } });
        previous = id; x += 260;
      }
      y += 170;
    }
    const metadata = {};
    for (const key of ['origin', 'item_defaults']) if (mechanics[key] !== undefined) metadata[key] = clone(mechanics[key]);
    return graphEnvelope({ nodes, links, frames: [], groups: [] }, metadata);
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
    const edition = context.edition === undefined ? undefined : String(context.edition);
    const level = context.level === undefined ? undefined : Number(context.level);
    function outputValue(endpoint) {
      const node = byId.get(endpoint?.node); if (!node) return undefined;
      const p = node.params || {};
      if (node.type.startsWith('data.')) return clone(p.value);
      if (node.type === 'condition.edition') return edition === undefined ? undefined : (p.editions || []).map(String).includes(edition);
      if (node.type === 'condition.level') return !Number.isFinite(level) ? undefined : level >= p.min && level <= p.max;
      if (node.type === 'condition.subclass') return context.subclass === undefined ? undefined : String(context.subclass) === String(p.id);
      if (node.type === 'condition.choice') {
        if (!context.choices) return undefined;
        return JSON.stringify(context.choices[p.id]) === JSON.stringify(p.value);
      }
      return undefined;
    }
    function inputValue(node, socket, fallback) {
      const source = incoming.get(`${node.id}:${socket}`);
      return source ? outputValue(source) : fallback;
    }
    const programs = [];
    for (const n of expanded.nodes.filter(node => node.type === 'action.program')) {
      const params = n.params || {}, programId = String(params.program_id || n.id);
      const p = { id: programId, name: String(params.name || 'Действие'), trigger: params.trigger === 'passive' ? 'passive' : 'use', blocks: [] };
      for (const key of ['feature_name', 'group', 'roll_only']) if (params[key] !== undefined) p[key] = clone(params[key]);
      const pending = [...(outgoing.get(`${n.id}:exec`) || [])].reverse(), visited = new Set();
      while (pending.length) {
        const nodeId = pending.pop(); if (visited.has(nodeId)) continue; visited.add(nodeId);
        const node = byId.get(nodeId); if (!node) continue;
        if (node.type === 'flow.if') {
          const condition = inputValue(node, 'condition', undefined);
          const sockets = condition === undefined ? ['else', 'then'] : [condition ? 'then' : 'else'];
          for (const socket of sockets) for (const target of [...(outgoing.get(`${node.id}:${socket}`) || [])].reverse()) pending.push(target);
          continue;
        }
        if (!actionType(node.type)) continue;
        const kind = node.type.slice(7), ap = clone(node.params || {}), blockId = ap.block_id || node.id;
        const enabled = inputValue(node, 'enabled', ap.enabled);
        if (enabled !== false) {
          if (enabled !== undefined) ap.enabled = enabled;
          delete ap.block_id; delete ap.enabled_input;
          p.blocks.push({ ...ap, id: blockId, kind });
        }
        for (const target of [...(outgoing.get(`${node.id}:exec`) || [])].reverse()) pending.push(target);
      }
      programs.push(p);
    }
    const out = { version: 1, programs };
    for (const key of ['origin', 'item_defaults']) if (mechanics[key] !== undefined) out[key] = clone(mechanics[key]);
    return Base.normalize(out);
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
    const def = NODE_DEFS[node.type];
    return def ? { inputs: def.inputs, outputs: def.outputs } : { inputs: {}, outputs: {} };
  }
  const fail = message => message;
  const idText = (value, max = 80) => typeof value === 'string' && value.length > 0 && value.length <= max;
  function validateInterface(list) {
    if (!Array.isArray(list) || list.length > 16) return 'Интерфейс группы: не более 16 сокетов.';
    const ids = new Set();
    for (const socket of list) {
      if (!socket || !idText(socket.id, 64) || ids.has(socket.id) || typeof socket.name !== 'string' || !socket.name.trim() || socket.name.length > 100 || !VALUE_TYPES.includes(socket.type)) return 'Некорректный типизированный сокет группы.';
      ids.add(socket.id);
    }
    return '';
  }
  function validateGraph(graph, groups = [], nested = false, ownerGroup = null) {
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
    const nodeIds = new Set();
    for (const node of nodes) {
      if (!node || !idText(node.id, 100) || nodeIds.has(node.id) || !NODE_DEFS[node.type]) return fail('Неизвестный узел или повторяющийся ID.');
      nodeIds.add(node.id);
      if (node.params !== undefined && (!node.params || typeof node.params !== 'object' || Array.isArray(node.params) || JSON.stringify(node.params).length > 100000)) return fail('Параметры узла должны быть ограниченным JSON-объектом.');
      if (node.position !== undefined && (!node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) || Math.abs(node.position.x) > 100000 || Math.abs(node.position.y) > 100000)) return fail('Координаты узла вне допустимых пределов.');
      if (node.type === 'group.instance' && !groupMap.has(String(node.params?.group_id || ''))) return fail('Узел ссылается на отсутствующую группу.');
      if (['group.input', 'group.output'].includes(node.type) && (!nested || !ownerGroup)) return fail('Узлы интерфейса группы разрешены только внутри повторно используемой группы.');
      const paramsError = validateNodeParams(node);
      if (paramsError) return paramsError;
    }
    const incoming = new Set(), adjacency = new Map([...nodeIds].map(id => [id, []])), indegree = new Map([...nodeIds].map(id => [id, 0]));
    const linkKeys = new Set();
    for (const link of links) {
      const source = link?.from, target = link?.to;
      if (!source || !target || !nodeIds.has(source.node) || !nodeIds.has(target.node)) return fail('Провод указывает на отсутствующий узел.');
      const fromNode = nodes.find(n => n.id === source.node), toNode = nodes.find(n => n.id === target.node);
      const fromSockets = socketMap(fromNode, groupMap, ownerGroup).outputs, toSockets = socketMap(toNode, groupMap, ownerGroup).inputs;
      if (!Object.hasOwn(fromSockets, source.socket) || !Object.hasOwn(toSockets, target.socket)) return fail('Провод подключён к отсутствующему сокету.');
      if (fromSockets[source.socket] !== toSockets[target.socket]) return fail('Типы сокетов провода не совпадают.');
      const targetKey = `${target.node}:${target.socket}`;
      if (incoming.has(targetKey)) return fail('К каждому входному сокету подключается только один провод.');
      incoming.add(targetKey);
      const linkKey = `${source.node}:${source.socket}>${target.node}:${target.socket}`;
      if (linkKeys.has(linkKey)) return fail('Повторяющийся провод.');
      linkKeys.add(linkKey);
      adjacency.get(source.node).push(target.node); indegree.set(target.node, indegree.get(target.node) + 1);
    }
    for (const node of nodes) if (node.type === 'flow.if' && !incoming.has(`${node.id}:condition`)) return fail('Условному узлу требуется типизированное логическое условие.');
    const queue = [...nodeIds].filter(id => indegree.get(id) === 0); let visited = 0;
    while (queue.length) { const current = queue.pop(); visited++; for (const target of adjacency.get(current)) { indegree.set(target, indegree.get(target) - 1); if (indegree.get(target) === 0) queue.push(target); } }
    if (visited !== nodeIds.size) return fail('Цикл в графе запрещён.');
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
        const error = validateGraph({ nodes: group.nodes, links: group.links, frames: group.frames || [] }, groups, true, group);
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
  function validateNodeParams(node) {
    const p = node.params || {}, type = node.type;
    const stringList = value => Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string' && item.length <= 200);
    const tableValue = value => value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 100000;
    if (type === 'data.number' && !Number.isFinite(p.value)) return 'Числовой узел должен содержать конечное число.';
    if (type === 'data.dice' && (!p.value || typeof p.value !== 'object' || Array.isArray(p.value) || !Number.isInteger(p.value.count) || p.value.count < 0 || p.value.count > 100 || !Number.isInteger(p.value.sides) || p.value.sides < 1 || p.value.sides > 1000 || !Number.isInteger(p.value.bonus ?? 0) || Math.abs(p.value.bonus ?? 0) > 1000000 || !['', ...ABILITIES, 'best', 'prof', 'atk', 'atk_str', 'atk_dex', 'spell', 'spell_mod', 'level', 'dc'].includes(p.value.stat ?? ''))) return 'Узел кости должен содержать количество и грани.';
    if (type === 'data.ability' && !ABILITIES.includes(p.value)) return 'Выберите характеристику из закрытого списка.';
    if (type === 'data.table' && (!p.value || typeof p.value !== 'object' || Array.isArray(p.value))) return 'Табличный узел должен содержать JSON-объект.';
    if (type === 'data.choice' && (!p.value || typeof p.value !== 'object' || Array.isArray(p.value))) return 'Узел выбора должен содержать JSON-объект.';
    if (type === 'data.text' && (typeof p.value !== 'string' || p.value.length > 4000)) return 'Текстовый узел: до 4000 символов.';
    if (type === 'condition.edition' && (!Array.isArray(p.editions) || !p.editions.length || p.editions.length > 2 || p.editions.some(x => typeof x !== 'string' || !['2014', '2024'].includes(x)))) return 'Условие редакции: один или несколько допустимых SRD.';
    if (type === 'condition.level' && (!Number.isInteger(p.min) || !Number.isInteger(p.max) || p.min < 1 || p.max > 20 || p.min > p.max)) return 'Условие уровня: диапазон 1–20.';
    if (type === 'condition.subclass' && (!idText(p.id, 100))) return 'Укажите ID подкласса в условии.';
    if (type === 'condition.choice' && (!idText(p.id, 100) || !Object.hasOwn(p, 'value'))) return 'Укажите ID группы и сравниваемый выбор.';
    if (type === 'flow.if' && Object.keys(p).length > 8) return 'Условный узел содержит лишние параметры.';
    if (type === 'action.program' && (!idText(p.program_id, 100) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120 || !['use', 'passive'].includes(p.trigger))) return 'Программе нужны ID, название и допустимый триггер.';
    if (['group.input', 'group.output'].includes(type) && !idText(p.socket_id, 64)) return 'Узел границы группы должен ссылаться на сокет интерфейса.';
    if (actionType(type)) {
      if (!idText(p.block_id, 100)) return 'Узел действия должен иметь стабильный block_id.';
      const kind = type.slice(7);
      if (['attack', 'damage', 'heal', 'temp_hp', 'roll'].includes(kind)) {
        const error = Base.validate({ version: 1, programs: [{ id: 'p', name: 'p', trigger: 'use', blocks: [{ id: 'b', kind, dice: p.dice || { count: 0, sides: 6, bonus: 0 }, enabled: p.enabled, when: p.when }] }] });
        if (error && !p.dice?.advanced) return error;
      }
    }
    if (type === 'rule.ability_bonus' && (!ABILITIES.includes(p.ability) || (p.amount !== undefined && (!Number.isFinite(p.amount) || Math.abs(p.amount) > 1000)))) return 'Бонус характеристики требует существующий ключ характеристики и конечную величину.';
    if (type === 'rule.speed' && p.value !== undefined && (!Number.isInteger(p.value) || p.value < 0 || p.value > 1000)) return 'Скорость должна быть целым числом от 0 до 1000.';
    if (type === 'rule.languages' && p.value !== undefined && !stringList(p.value)) return 'Языки должны быть списком текстовых значений.';
    if (type === 'rule.proficiencies' && (p.value !== undefined && !stringList(p.value) || (p.kind !== undefined && (typeof p.kind !== 'string' || p.kind.length > 120)))) return 'Владения должны быть списком и иметь короткий тип.';
    if (type === 'rule.hit_die' && p.value !== undefined && (typeof p.value !== 'string' || !/^d(?:6|8|10|12)$/.test(p.value))) return 'Кость хитов: d6, d8, d10 или d12.';
    if (type === 'rule.saving_throws' && p.value !== undefined && (!Array.isArray(p.value) || p.value.length > 6 || p.value.some(v => !ABILITIES.includes(v)))) return 'Спасброски должны быть списком характеристик.';
    if (type === 'rule.feature' && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120 || (p.text !== undefined && (typeof p.text !== 'string' || p.text.length > 4000)))) return 'Умение: название до 120 и текст до 4000 символов.';
    if (type === 'rule.skills' && (!idText(p.id, 100) || !Number.isInteger(p.count) || p.count < 0 || p.count > 18 || !stringList(p.options) || p.options.length > 18)) return 'Выбор навыков: ID, список до 18 и количество от 0 до 18.';
    if (type === 'rule.spell_list' && (!['known', 'prepared', 'book'].includes(p.mode) || (p.ability !== undefined && !ABILITIES.includes(p.ability)) || !stringList(p.spells))) return 'Список заклинаний: режим, список и характеристика должны быть допустимы.';
    if (['rule.spell_slots', 'rule.asi', 'rule.class_progression'].includes(type) && p.table !== undefined && !tableValue(p.table)) return 'Табличное правило должно содержать ограниченный JSON-объект.';
    if (type === 'rule.armor_formula') {
      const formulaError = typeof p.formula === 'string' && p.formula.length <= 100 ? Formulas.validate(p.formula) : 'Формула защиты: строка до 100 символов.';
      if (formulaError) return `Формула защиты без доспехов: ${formulaError}`;
      if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 120)) return 'Название защиты без доспехов: строка до 120 символов.';
      if (p.no_shield !== undefined && typeof p.no_shield !== 'boolean') return 'Запрет щита: логическое значение.';
    }
    if (type === 'rule.hp_bonus' && p.amount !== undefined && (!Number.isInteger(p.amount) || Math.abs(p.amount) > 1000)) return 'Бонус хитов: целое от −1000 до 1000.';
    if (type === 'rule.manual' && (typeof p.text !== 'string' || p.text.length > 4000)) return 'Ручное правило: до 4000 символов.';
    return '';
  }
  function toGraph(mechanics) { return v1ToV2(mechanics); }
  function validate(mechanics) {
    if (!mechanics || ![1, GRAPH_VERSION].includes(mechanics.version)) return 'Неподдерживаемая схема механик.';
    if (mechanics.version === 1) return Base.validate(mechanics);
    if (!mechanics.graph || !Array.isArray(mechanics.graph.groups)) return 'Не более 50 групп повторного использования.';
    if (JSON.stringify(mechanics).length > 1_000_000) return 'Неподдерживаемая или слишком большая схема механик.';
    const error = validateGraph(mechanics.graph, mechanics.graph.groups);
    if (error) return error;
    const legacy = v2ToV1(mechanics);
    const legacyError = Base.validate(legacy);
    if (legacyError) return legacyError;
    const allNodes = [...(mechanics.graph.nodes || []), ...(mechanics.graph.groups || []).flatMap(g => g.nodes || [])];
    for (const n of allNodes) {
      const e = validateNodeParams(n);
      if (e) return e;
    }
    return '';
  }

  function valueForInput(node, socket, values) {
    const linked = values.linksByTarget.get(`${node.id}:${socket}`);
    if (linked) return values.outputs.get(`${linked.node}:${linked.socket}`);
    return node.params?.[socket] ?? node.params?.value;
  }
  function orderedNodes(graph, groups) {
    const expanded = expandGroups(graph, groups);
    const incoming = new Map(), adjacency = new Map(), indegree = new Map();
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
  function applyRuleNode(type, p, incoming, sheet, context, outputs) {
    const on = incoming('enabled'); if (on === false) return;
    const n = input => incoming(input);
    const value = input => n(input) ?? p[input] ?? p.value;
    const emit = (kind, data = {}) => context.effects.push({ kind, ...clone(data), source: context.source || '', node_id: context.nodeId });
    if (type === 'rule.ability_bonus') {
      const ability = p.ability, amount = Number(value('amount')) || 0;
      if (ABILITIES.includes(ability)) { sheet.abilities[ability] = (Number(sheet.abilities[ability]) || 10) + amount; emit('ability_bonus', { ability, amount }); }
    } else if (type === 'rule.speed') { const v = Number(value('value')); if (Number.isFinite(v)) { sheet.speed = v; emit('speed', { value: v }); }
    } else if (type === 'rule.languages') {
      const langs = valuesOf(value('value')).map(String).filter(Boolean); sheet.languages.push(...langs); appendProficiency(sheet, 'Языки', langs); emit('languages', { values: langs });
    } else if (type === 'rule.proficiencies') {
      const profs = valuesOf(value('value')).map(String).filter(Boolean); appendProficiency(sheet, p.kind || 'Владения', profs); emit('proficiencies', { label: p.kind || 'Владения', values: profs });
    } else if (type === 'rule.hit_die') { const die = value('value'); if (die) { sheet.hp.hit_dice = `1${die}`; emit('hit_die', { value: die }); }
    } else if (type === 'rule.saving_throws') {
      const saves = valuesOf(value('value')).filter(x => ABILITIES.includes(x)); sheet.saving_throws = [...new Set([...sheet.saving_throws, ...saves])]; emit('saving_throws', { values: saves });
    } else if (type === 'rule.feature') {
      const feature = { name: p.name, text: p.text || '', source: context.source || '', mechanic_node_id: context.featureNodeId || '' }; sheet.features.push(feature); emit('feature', { feature });
    } else if (type === 'rule.skills') {
      const id = String(p.id || ''), options = valuesOf(n('options') ?? p.options), count = Number(n('count') ?? p.count) || 0;
      const selected = valuesOf(context.choices?.[id]).slice(0, Math.max(0, count));
      sheet.skill_choices.push({ id, count, options: options.map(String), selected: selected.map(String) });
      sheet.skills.push(...selected.map(String)); emit('skills', { id, count, options: options.map(String), selected: selected.map(String) });
    } else if (type === 'rule.spell_list') {
      const spells = valuesOf(n('spells') ?? p.spells); sheet.spell_rules.push({ mode: p.mode, ability: p.ability || '', spells: clone(spells) }); emit('spell_list', { mode: p.mode, ability: p.ability || '', spells });
    } else if (type === 'rule.spell_slots') {
      const table = n('table') ?? p.table; if (table && typeof table === 'object') { sheet.spell_progression.slots = clone(table); emit('spell_slots', { table }); }
    } else if (type === 'rule.asi') {
      const table = n('table') ?? p.table; if (table && typeof table === 'object') { sheet.asi_rules.push(clone(table)); emit('asi', { table }); }
    } else if (type === 'rule.class_progression') {
      const table = n('table') ?? p.table; if (table && typeof table === 'object') { sheet.class_progression = clone(table); emit('class_progression', { table }); }
    } else if (type === 'rule.armor_formula') { const rule = { formula: String(n('formula') ?? p.formula ?? ''), name: String(p.name || 'Защита без доспехов').slice(0, 120), no_shield: Boolean(p.no_shield) }; sheet.unarmored_defense = clone(rule); emit('unarmored_defense', rule);
    } else if (type === 'rule.hp_bonus') { const amount = Number(n('amount') ?? p.amount) || 0; sheet.hp.max += amount; sheet.hp.current += amount; emit('hp_bonus', { amount });
    } else if (type === 'rule.manual') { const text = String(n('text') ?? p.text ?? ''); sheet.manual_rules.push(text); emit('manual', { text }); }
    outputs.set(`${context.nodeId}:effect`, { type: 'effect', node_type: type });
  }
  function appendProficiency(sheet, label, values) {
    const text = (values || []).map(x => String(x || '').trim()).filter(Boolean).join(', ');
    if (text) sheet.proficiencies += `${label}: ${text}\n`;
  }
  function evaluateGraph(mechanics, options = {}) {
    const graphMechanics = toGraph(mechanics);
    const validation = validate(graphMechanics);
    if (validation) return { error: validation, sheet: null };
    const edition = String(options.edition || '2014');
    const level = Math.max(1, Math.min(20, Math.trunc(Number(options.level) || 1)));
    const sheet = { edition, level, abilities: Object.fromEntries(ABILITIES.map(k => [k, 10])), race: '', class: '', subclass: '', speed: 30, hp: { max: 0, current: 0, temp: 0 },
      features: [], saving_throws: [], skills: [], skill_choices: [], languages: [], proficiencies: '', spells: { ability: '', slots: {}, known: [] }, spell_rules: [], spell_progression: { slots: {} }, asi_rules: [], class_progression: null, armor_formula: '', manual_rules: [] };
    const { ordered, linksByTarget } = orderedNodes(graphOf(graphMechanics), new Map((graphMechanics.graph.groups || []).map(g => [g.id, g])));
    const values = { linksByTarget, outputs: new Map() };
    const context = { edition, level, subclass: options.subclass || '', choices: options.choices || {}, source: options.source || '', nodeId: '', effects: [] };
    const get = (node, socket) => valueForInput(node, socket, values);
    for (const node of ordered) {
      context.nodeId = node.id;
      const p = node.params || {}, type = node.type;
      if (type === 'data.number' || type === 'data.dice' || type === 'data.ability' || type === 'data.table' || type === 'data.choice' || type === 'data.text') values.outputs.set(`${node.id}:value`, clone(p.value));
      else if (type === 'condition.edition') values.outputs.set(`${node.id}:value`, (p.editions || []).map(String).includes(edition));
      else if (type === 'condition.level') values.outputs.set(`${node.id}:value`, level >= p.min && level <= p.max);
      else if (type === 'condition.subclass') values.outputs.set(`${node.id}:value`, String(context.subclass) === String(p.id));
      else if (type === 'condition.choice') values.outputs.set(`${node.id}:value`, JSON.stringify(context.choices?.[p.id]) === JSON.stringify(p.value));
      else if (type.startsWith('rule.')) applyRuleNode(type, p, socket => get(node, socket), sheet, context, values.outputs);
    }
    sheet.skills = [...new Set(sheet.skills)];
    return { error: '', sheet, manual_rules: sheet.manual_rules, effects: context.effects, actions: v2ToV1(graphMechanics, { edition, level, subclass: options.subclass || '', choices: options.choices || {} }).programs || [] };
  }
  function applyGraphRules(mechanics, target, options = {}) {
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
      else if (effect.kind === 'spell_list') target.graph_spell_rules.push({ mode: effect.mode, ability: effect.ability, spells: clone(effect.spells), source: effect.source });
      else if (effect.kind === 'spell_slots') target.spells.slots = { ...target.spells.slots, ...clone(effect.table) };
      else if (effect.kind === 'asi') target.asi_rules.push(clone(effect.table));
      else if (effect.kind === 'class_progression') target.class_progression = clone(effect.table);
      else if (effect.kind === 'unarmored_defense') target.unarmored_defense = { formula: effect.formula, name: effect.name, no_shield: effect.no_shield };
      else if (effect.kind === 'hp_bonus') { target.hp.max += effect.amount; target.hp.current += effect.amount; }
      else if (effect.kind === 'manual') (target.manual_rules ||= []).push(effect.text);
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
      actions: result.actions.map(p => ({ name: p.name, trigger: p.trigger, blocks: p.blocks.map(b => b.kind) })) };
  }
  function adaptForRead(mechanics) { return mechanics?.version === 1 ? v1ToV2(mechanics) : clone(mechanics); }

  function graphEditor(doc, options = {}) {
    const category = options.category || 'feature';
    const seed = doc.mechanics || Base.migrate(doc, category);
    let mechanics = adaptForRead(seed);
    if (mechanics.version !== GRAPH_VERSION) mechanics = v1ToV2(seed);
    // Форма вызывается с копией записи; исходник не отправляется на сервер до внешнего «Сохранить».
    doc.mechanics = mechanics;
    const graph = mechanics.graph;
    const root = el('section', { class: 'node-editor', tabindex: 0, 'aria-label': 'Редактор графа механик' });
    const history = [JSON.stringify(graph)]; let historyIndex = 0, selected = new Set(), activeNode = '', pendingPort = null, status = '', search = '', currentEdition = '2014', currentLevel = 1, currentChoices = {}, currentSubclass = '', drag = null;
    const field = (label, control) => el('label', { class: 'node-field' }, el('span', {}, label), control);
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
      const id = mkId('node'), count = graph.nodes.length;
      graph.nodes.push({ id, type, params: params ? clone(params) : clone(NODE_DEFS[type].defaults), position: at || { x: 60 + (count % 4) * 250, y: 70 + Math.floor(count / 4) * 170 } });
      checkpoint(); activeNode = id; selected = new Set([id]); render();
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
    function choosePort(node, direction, socket) {
      if (direction === 'outputs') {
        pendingPort = { node: node.id, socket, type: portType(node, direction, socket) };
        status = `Выход «${socket}» выбран. Теперь нажмите совместимый вход.`; render(); return;
      }
      if (!pendingPort) { status = 'Сначала выберите выходной порт.'; render(); return; }
      const targetType = portType(node, direction, socket);
      if (!targetType || targetType !== pendingPort.type) { status = 'Типы сокетов не совпадают.'; render(); return; }
      if (pendingPort.node === node.id) { status = 'Нельзя соединить узел с самим собой.'; render(); return; }
      graph.links = graph.links.filter(l => !(l.to.node === node.id && l.to.socket === socket));
      graph.links.push({ from: { node: pendingPort.node, socket: pendingPort.socket }, to: { node: node.id, socket } });
      checkpoint(); pendingPort = null; status = ''; render();
    }
    function addFrame() {
      const members = [...selected]; if (!members.length) { status = 'Выберите узел(ы) рамки с Ctrl/⌘ + щелчок.'; render(); return; }
      graph.frames.push({ id: mkId('frame'), title: `Рамка ${graph.frames.length + 1}`, nodes: members }); checkpoint(); status = ''; render();
    }
    function makeGroup() {
      const ids = new Set(selected); if (!ids.size) { status = 'Выберите узлы, которые нужно сгруппировать.'; render(); return; }
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
      graph.nodes.push({ id: instanceId, type: 'group.instance', params: { group_id: groupId }, position: { x, y } });
      graph.frames.forEach(frame => frame.nodes = frame.nodes.filter(id => !ids.has(id)));
      checkpoint(); selected.clear(); activeNode = instanceId; selected.add(instanceId); status = 'Группа создана с типизированными входами и выходами. Её можно повторно вставить из списка групп.'; render();
    }
    function insertGroup(group) {
      const id = mkId('instance'); graph.nodes.push({ id, type: 'group.instance', params: { group_id: group.id }, position: { x: 80 + graph.nodes.length * 28, y: 80 + graph.nodes.length * 24 } });
      checkpoint(); activeNode = id; selected = new Set([id]); status = ''; render();
    }
    function moveNode(node, x, y) { node.position ||= { x: 0, y: 0 }; node.position.x = Math.max(-100000, Math.min(100000, x)); node.position.y = Math.max(-100000, Math.min(100000, y)); }
    function nodeById(id) { return graph.nodes.find(n => n.id === id); }
    function nodeCard(node) {
      const pos = node.position || { x: 0, y: 0 }, group = node.type === 'group.instance' ? graph.groups.find(g => g.id === node.params?.group_id) : null;
      const inputs = socketMap(node, new Map(graph.groups.map(g => [g.id, g]))).inputs;
      const outputs = socketMap(node, new Map(graph.groups.map(g => [g.id, g]))).outputs;
      const sockets = el('div', { class: 'node-sockets' }, el('div', { class: 'node-inputs' }, ...Object.entries(inputs).map(([name, type]) => el('button', { class: `node-socket in socket-${type}`, title: `${portLabel(node, 'inputs', name)} · ${type}`, onclick: e => { e.stopPropagation(); choosePort(node, 'inputs', name); } }, el('i'), portLabel(node, 'inputs', name)))),
        el('div', { class: 'node-outputs' }, ...Object.entries(outputs).map(([name, type]) => el('button', { class: `node-socket out socket-${type}`, title: `${portLabel(node, 'outputs', name)} · ${type}`, onclick: e => { e.stopPropagation(); choosePort(node, 'outputs', name); } }, portLabel(node, 'outputs', name), el('i')))));
      const card = el('article', { class: 'graph-node' + (selected.has(node.id) ? ' selected' : '') + (node.type.startsWith('action.') ? ' action-node' : node.type.startsWith('rule.') ? ' rule-node' : ''), style: `left:${pos.x}px;top:${pos.y}px`, 'data-node-id': node.id,
        onclick: e => { activeNode = node.id; if (e.ctrlKey || e.metaKey || e.shiftKey) { if (selected.has(node.id)) selected.delete(node.id); else selected.add(node.id); } else selected = new Set([node.id]); render(); } },
        el('header', { class: 'graph-node-head', onpointerdown: e => { if (e.target?.closest?.('button')) return; drag = { id: node.id, x: e.clientX, y: e.clientY, left: pos.x, top: pos.y }; e.preventDefault?.(); } },
          el('span', { class: 'node-dot' }), el('b', {}, group?.name || nodeLabel(node.type)), el('button', { class: 'node-delete', title: 'Удалить узел', onclick: e => { e.stopPropagation(); graph.nodes = graph.nodes.filter(n => n.id !== node.id); graph.links = graph.links.filter(l => l.from.node !== node.id && l.to.node !== node.id); graph.frames.forEach(f => f.nodes = f.nodes.filter(n => n !== node.id)); selected.delete(node.id); if (activeNode === node.id) activeNode = ''; checkpoint(); render(); } }, '×')),
        el('div', { class: 'node-id muted' }, node.id.slice(0, 18)), sockets);
      return card;
    }
    function drawWires(canvas) {
      if (!document.createElementNS) return;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'node-wires'); svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); svg.setAttribute('aria-hidden', 'true');
      for (const link of graph.links) {
        const a = nodeById(link.from.node), b = nodeById(link.to.node); if (!a || !b) continue;
        const x1 = (a.position?.x || 0) + 224, y1 = (a.position?.y || 0) + 56;
        const x2 = (b.position?.x || 0), y2 = (b.position?.y || 0) + 56;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${x1} ${y1} C ${x1 + 80} ${y1}, ${x2 - 80} ${y2}, ${x2} ${y2}`); path.setAttribute('class', 'node-wire');
        svg.appendChild(path);
      }
      canvas.appendChild(svg);
    }
    function renderProperties() {
      const node = nodeById(activeNode); if (!node) return el('aside', { class: 'node-properties' }, el('h3', {}, 'Параметры узла'), el('p', { class: 'muted small' }, 'Выберите узел на поле.'));
      const rawParams = el('textarea', { class: 'node-params', spellcheck: 'false', 'aria-label': 'JSON параметров узла', onfocus: () => { rawParams.value = JSON.stringify(node.params || {}, null, 2); }, onchange: () => {
        try { const next = JSON.parse(rawParams.value); if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('Параметры должны быть JSON-объектом.'); node.params = next; checkpoint(); status = ''; render(); }
        catch (e) { status = e.message; if (root._statusNode) root._statusNode.textContent = status; }
      } }, JSON.stringify(node.params || {}, null, 2));
      const groupOptions = graph.groups.map(item => ({ value: item.id, label: item.name }));
      const form = NodeForm.nodeParams(node, { groups: groupOptions, onChange: next => { node.params = next; checkpoint(); status = ''; render(); } });
      const raw = el('details', { class: 'node-raw' }, el('summary', {}, 'Для разработчиков · JSON'), rawParams);
      const def = NODE_DEFS[node.type], group = node.type === 'group.instance' ? graph.groups.find(item => item.id === node.params?.group_id) : null;
      const groupDetails = group ? el('div', { class: 'node-group-details' }, field('Имя группы', el('input', { value: group.name, onchange: e => { group.name = String(e.target.value).slice(0, 120) || group.name; checkpoint(); render(); } })),
        el('p', { class: 'muted small' }, `Входы: ${(group.inputs || []).map(item => `${item.name} · ${item.type}`).join(', ') || 'нет'}`),
        el('p', { class: 'muted small' }, `Выходы: ${(group.outputs || []).map(item => `${item.name} · ${item.type}`).join(', ') || 'нет'}`)) : null;
      return el('aside', { class: 'node-properties' }, el('h3', {}, 'Параметры узла'), el('b', {}, def.label), el('p', { class: 'muted small' }, node.type), groupDetails, el('div', { class: 'node-field' }, el('span', {}, 'Параметры'), form), raw, el('button', { class: 'small danger', onclick: () => { graph.nodes = graph.nodes.filter(n => n.id !== node.id); graph.links = graph.links.filter(l => l.from.node !== node.id && l.to.node !== node.id); activeNode = ''; selected.delete(node.id); checkpoint(); render(); } }, 'Удалить узел'));
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
      root.replaceChildren();
      const searchBox = el('input', { class: 'node-search', value: search, placeholder: 'Найти узел…  Shift+A', 'aria-label': 'Поиск узла', oninput: e => { search = e.target.value; render(); root.querySelector?.('.node-search')?.focus?.(); } });
      const query = search.toLocaleLowerCase();
      const palette = Object.entries(NODE_DEFS).filter(([type, def]) => !['group.input', 'group.output'].includes(type) && (!query || `${type} ${def.label} ${def.group}`.toLocaleLowerCase().includes(query)));
      const toolbar = el('div', { class: 'node-toolbar' }, field('Поиск / добавить узел', searchBox), ...palette.slice(0, 8).map(([type, def]) => el('button', { class: 'small node-add', title: type, onclick: () => addNode(type) }, '+ ', def.label)),
        el('button', { class: 'small', disabled: historyIndex <= 0 ? '' : null, onclick: () => restore(historyIndex - 1) }, '↶ Отменить'),
        el('button', { class: 'small', disabled: historyIndex >= history.length - 1 ? '' : null, onclick: () => restore(historyIndex + 1) }, '↷ Повторить'),
        el('button', { class: 'small', onclick: addFrame }, '＋ Рамка'), el('button', { class: 'small', onclick: makeGroup }, 'Сгруппировать'));
      const groupShelf = graph.groups.length ? el('div', { class: 'node-group-shelf' }, el('b', {}, 'Группы'), ...graph.groups.map(g => el('button', { class: 'small', onclick: () => insertGroup(g) }, 'Вставить: ', g.name))) : null;
      const canvas = el('div', { class: 'node-canvas', onpointermove: e => {
        if (!drag) return; const node = nodeById(drag.id); if (!node) return;
        moveNode(node, drag.left + e.clientX - drag.x, drag.top + e.clientY - drag.y);
        const card = root.querySelector?.(`[data-node-id="${drag.id}"]`); if (card) card.style = `left:${node.position.x}px;top:${node.position.y}px`;
      }, onpointerup: () => { if (drag) { checkpoint(); drag = null; render(); } } }, ...graph.frames.map(f => {
        const members = f.nodes.map(nodeById).filter(Boolean); if (!members.length) return null;
        const left = Math.min(...members.map(n => n.position?.x || 0)) - 16, top = Math.min(...members.map(n => n.position?.y || 0)) - 34;
        return el('div', { class: 'node-frame', style: `left:${left}px;top:${top}px;width:${Math.max(230, ...members.map(n => (n.position?.x || 0) - left + 230))}px;height:${Math.max(100, ...members.map(n => (n.position?.y || 0) - top + 120))}px` }, el('b', {}, f.title));
      }), ...graph.nodes.map(nodeCard));
      drawWires(canvas);
      const inspector = renderProperties();
      const statusLine = el('div', { class: 'node-status', role: 'status' }, status);
      root.append(toolbar, groupShelf, el('div', { class: 'node-workspace' }, canvas, inspector), statusLine, renderPreview());
      // Keep status reference in a closure-safe property for JSON validation errors.
      root._statusNode = statusLine;
    }
    root.addEventListener('keydown', e => {
      if (e.shiftKey && String(e.key).toLowerCase() === 'a') { e.preventDefault(); const input = root.querySelector?.('.node-search'); input?.focus?.(); input?.select?.(); }
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'z') { e.preventDefault(); restore(e.shiftKey ? historyIndex + 1 : historyIndex - 1); }
      if (e.key === 'Escape') { pendingPort = null; status = ''; render(); }
    });
    root.addEventListener('pointermove', e => { if (drag) { const node = nodeById(drag.id); if (node) moveNode(node, drag.left + e.clientX - drag.x, drag.top + e.clientY - drag.y); } });
    // Validation and cancel are controlled by the enclosing record modal.
    mechanics = graphEnvelope(graph, Object.fromEntries(Object.entries(mechanics).filter(([k]) => k !== 'version' && k !== 'graph')));
    doc.mechanics = mechanics;
    render();
    return root;
  }

  const oldButtons = Base.buttons, oldPreview = Base.preview, oldProgramsOf = Base.programsOf, oldForFeature = Base.forFeature, oldPassiveData = Base.passiveData, oldStarter = Base.starter, oldMigrate = Base.migrate;
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
    toGraph,
    toLegacy: v2ToV1,
    validateGraph,
    graphPreview: previewGraph,
    evaluateGraph,
    applyGraphRules,
    normalize(mechanics) { return mechanics?.version === GRAPH_VERSION ? clone(mechanics) : Base.normalize(mechanics); },
    validate,
    programsOf(mechanics, context) { return mechanics?.version === GRAPH_VERSION ? Base.programsOf(v2ToV1(mechanics, runtimeContext(context))) : oldProgramsOf(mechanics); },
    migrate(doc, category) { const m = oldMigrate(doc, category); return v1ToV2(m); },
    starter(category) { const m = oldStarter(category); return m ? v1ToV2(m) : undefined; },
    forFeature(mechanics, name, context) { const m = v2ToV1(mechanics, runtimeContext(context)); const out = oldForFeature(m, name); return out ? v1ToV2(out) : undefined; },
    passiveData(entry, context) {
      const e = clone(entry), original = e.data?.mechanics;
      if (original?.version === GRAPH_VERSION) {
        const legacy = v2ToV1(original, runtimeContext(context)); const projected = oldPassiveData({ ...e, data: { ...e.data, mechanics: legacy } });
        projected.data.mechanics = original; return projected;
      }
      return oldPassiveData(e);
    },
    preview(mechanics, ctx) { return oldPreview(v2ToV1(mechanics, runtimeContext(ctx)), ctx); },
    buttons(doc, options = {}) { return oldButtons({ ...doc, mechanics: v2ToV1(doc.mechanics, runtimeContext(options.context)) }, options); },
    editor: graphEditor,
  };
  window.Mechanics = API;
})();
