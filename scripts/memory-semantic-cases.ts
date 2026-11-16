/** Frozen source material for real-model note/Dream acceptance, never a fake model. */
export type MemorySemanticCategory = 'short-answer' | 'quotation' | 'negation' | 'condition'
  | 'historical-correction' | 'project-procedure' | 'preference'

/** Regex sources, compiled with `iu`. These are audit signals, never a semantic verdict. */
export interface SemanticClaimPatterns {
  allOf: readonly string[]
  anyOf?: readonly string[]
  noneOf?: readonly string[]
}

export interface MemorySemanticTurn {
  id: string
  user: string
  /** Frozen assistant context, passed through the real completed-turn intake. */
  assistant: string
  /** A prior turn in this phase whose assistant actually asked this exact question. */
  answerTo?: { turnId: string, question: string }
}

export interface MemorySemanticExpectation {
  id: string
  semantic: string
  /** Required claims cannot all be skipped. Only an actually ambiguous optional claim may defer. */
  disposition: 'required' | 'may-defer'
  attribution: 'user' | 'third-party' | 'project'
  claimPatterns: SemanticClaimPatterns
  qualifierPatterns: readonly SemanticClaimPatterns[]
  negation: 'required' | 'forbidden' | 'preserve-exception' | 'not-applicable'
  /** Turn identities supporting this claim; actual source IDs are assigned by the runner. */
  evidenceTurns: readonly string[]
  audit: string
}

export interface MemorySemanticForbiddenClaim {
  semantic: string
  claimPatterns: SemanticClaimPatterns
  audit: string
}

export interface MemorySemanticPhase {
  id: string
  turns: readonly MemorySemanticTurn[]
  recallQuery: string
  expectations: readonly MemorySemanticExpectation[]
  forbidden: readonly MemorySemanticForbiddenClaim[]
  audit: readonly string[]
}

export interface MemorySemanticCase {
  id: string
  category: MemorySemanticCategory
  title: string
  scope: { kind: 'user' } | { kind: 'project', fixtureProject: string }
  /** Run note capture and a complete Dream/checkpoint after EACH phase. */
  phases: readonly MemorySemanticPhase[]
  audit: readonly string[]
}

export const MEMORY_SEMANTIC_AUDIT_RULES = Object.freeze([
  'Use real configured model computation for note, Extract, Integrate, Verify and Tag; preserve raw inputs, responses, tool transcripts, receipts and current projections for independent audit.',
  'Each phase is a real continuous session of completed human/assistant turns. Check answerTo against the exact prior assistant question; never invent question text inside a user source or promote an assistant assertion to independent evidence.',
  'Apply claimPatterns and qualifierPatterns only to one coherent claim/passsage with its attribution and scope, not arbitrary matches scattered across the entire recall packet. Patterns flag evidence to inspect; neither a hit nor a miss alone establishes semantic correctness.',
  'Manually judge attribution, polarity, time, conditions, exceptions and supporting canonical spans. Equivalent paraphrases may pass without matching the suggested patterns; matching words with changed meaning must fail.',
  'Inspect current authorized projections separately from retained history. A superseded fact may remain in evidence/history; it must not be presented as the current answer. Preserve unrelated independently supported claims.',
  'A genuinely ambiguous may-defer claim may remain deferred or omitted. Required unambiguous claims must appear in an accepted current digest and relevant recall; silently skipping every case is not a pass.',
  'A project case needs a trusted project origin, current-project retrieval, and foreign-project/user-only rejection probes. Project words in model text are not authority.',
  'Report this as a real-model memory extraction/integration semantic evaluation. It is separate from retrieval ranking, latency benchmarks, end-user answer quality, unit tests and PR CI.',
] as const)

export const MEMORY_SEMANTIC_CASES = [
  {
    id: 'short-answer-context', category: 'short-answer', title: '短答必须沿用真实问题的对象和范围', scope: { kind: 'user' },
    phases: [{
      id: 'confirmed-routine-report',
      turns: [
        { id: 's1', user: '我想把团队例行日报的发送安排留作长期约定，先帮我确认发送时间和接收人。', assistant: '团队例行日报通常在周几、几点发给谁？' },
        { id: 's2', user: '周四下午五点，给小岑。', assistant: '这是团队例行日报的发送安排，对吗？', answerTo: { turnId: 's1', question: '团队例行日报通常在周几、几点发给谁？' } },
        { id: 's3', user: '对。只针对例行日报，事故快报不按这个时间。', assistant: '我会区分例行日报和事故快报。', answerTo: { turnId: 's2', question: '这是团队例行日报的发送安排，对吗？' } },
        { id: 's4', user: '例行日报通过团队私聊发，附件用当天的检查表。', assistant: '已了解发送渠道和附件约定。' },
        { id: 's5', user: '这些是持续安排；临时改期时我会另外说明。', assistant: '后续临时改期会按新的原文说明处理。' },
      ],
      recallQuery: '我的团队例行日报通常什么时候、发给谁？事故快报也用这个时间吗？',
      expectations: [{
        id: 'routine-time-recipient', disposition: 'required', attribution: 'user',
        semantic: '用户的团队例行日报持续约定为周四17点发给小岑；事故快报不受此时间约束。',
        claimPatterns: { allOf: ['例行日报', '周四|星期四|每周四', '下午五点|17[：:]?00|17点', '小岑'] },
        qualifierPatterns: [{ allOf: ['事故快报', '不|另|除外'] }], negation: 'preserve-exception', evidenceTurns: ['s1', 's2', 's3', 's5'],
        audit: '核对s2的时间和接收人由s1真实问句确定，s3的“对”只确认该安排，不能抽成无对象的同意或扩展到所有报告。',
      }],
      forbidden: [{ semantic: '事故快报也固定周四17点发，或把小岑视为用户姓名。', claimPatterns: { allOf: ['事故快报', '周四|星期四'], noneOf: ['不|除外|另行|例外'] }, audit: '检查短答的主语、接收关系及事故快报例外，不能仅因时间词命中判正确。' }],
      audit: ['保留真实note模型input，确认s2/s3分别能看到前一轮问句；不能事后为短答构造一条完整用户陈述。'],
    }],
    audit: ['短答的来源仍是原始用户短答，问句只是解释上下文，不能替代或伪造独立用户授权。'],
  },
  {
    id: 'quoted-third-party', category: 'quotation', title: '第三方引文与用户自身事实分开', scope: { kind: 'user' },
    phases: [{
      id: 'two-distinct-people',
      turns: [
        { id: 'q1', user: '同事阿澄在群里说：“我以后周二在成都办公室。”', assistant: '这是阿澄的工作安排。' },
        { id: 'q2', user: '我是在转述阿澄；我本人继续在苏州办公。', assistant: '会保留转述者和实际主体的区别。' },
        { id: 'q3', user: '我通常周三去苏州西楼开组会。', assistant: '已了解你的组会安排。' },
        { id: 'q4', user: '阿澄的安排用于下次联调排期，我去不去成都还没计划。', assistant: '你的成都行程目前没有确定。' },
        { id: 'q5', user: '以后查我们的办公地点时，把两个人各自的安排说清楚。', assistant: '查询时会区分你和阿澄。' },
      ],
      recallQuery: '我在哪里办公，阿澄周二在哪里？我是否已经决定去成都？',
      expectations: [
        { id: 'user-suzhou', disposition: 'required', attribution: 'user', semantic: '用户继续在苏州办公，通常周三去苏州西楼开组会。', claimPatterns: { allOf: ['苏州', '办公|工作'] }, qualifierPatterns: [], negation: 'not-applicable', evidenceTurns: ['q2', 'q3'], audit: '用户办公地点来自q2，不得被引文内第一人称覆盖。' },
        { id: 'user-trip-uncertain', disposition: 'may-defer', attribution: 'user', semantic: '用户去成都尚未决定；可以省略该未定行程，不能保存为已决定。', claimPatterns: { allOf: ['成都', '未定|未决定|没计划|没有计划|尚未|不确定'] }, qualifierPatterns: [], negation: 'required', evidenceTurns: ['q4'], audit: '该未定行程允许不写，不因省略而失败；若有保存，必须保留不确定性。' },
        { id: 'achen-chengdu', disposition: 'required', attribution: 'third-party', semantic: '阿澄自述以后周二在成都办公室；这是被用户转述的同事安排。', claimPatterns: { allOf: ['阿澄', '成都', '周二|星期二'] }, qualifierPatterns: [{ anyOf: ['说|表示|自述|转述|同事'], allOf: [] }], negation: 'not-applicable', evidenceTurns: ['q1', 'q2', 'q4'], audit: '归属必须是阿澄，保留转述性质；不能宣称该第三方安排由用户亲自核验。' },
      ],
      forbidden: [{ semantic: '用户以后周二在成都办公或已经决定赴成都。', claimPatterns: { allOf: ['用户|本人|你', '成都', '办公|决定|将去|前往'], noneOf: ['未|没|尚|不确定|阿澄|转述'] }, audit: '逐句检查引文的第一人称是否被错误归给用户，或未定行程是否被写成已决定。' }],
      audit: ['第三方事实可以保留，但查询用户本人时不能将其当作用户画像。'],
    }],
    audit: ['若用户未定的成都行程被省略或标为不确定均可；不得为得到确定结果而替用户做决定。'],
  },
  {
    id: 'negative-preference', category: 'negation', title: '否定不能反转或扩大到其他人', scope: { kind: 'user' },
    phases: [{
      id: 'coffee-refusal',
      turns: [
        { id: 'n1', user: '我不喝咖啡，运动饮料也不喝；温白水可以。', assistant: '会保留你不喝的饮品和可选项。' },
        { id: 'n2', user: '开早会不用给我准备咖啡。', assistant: '你的早会饮品不安排咖啡。' },
        { id: 'n3', user: '如果办公室订饮料，我选温白水。', assistant: '订饮料时你选择温白水。' },
        { id: 'n4', user: '这不是今天临时不喝，平时也是这样。', assistant: '这是持续的个人习惯。' },
        { id: 'n5', user: '给客户准备咖啡不受我的个人习惯限制。', assistant: '不会把你的习惯扩大成客户接待禁令。' },
      ],
      recallQuery: '早会给我准备什么饮品？客户来访还能准备咖啡吗？',
      expectations: [{ id: 'no-coffee', disposition: 'required', attribution: 'user', semantic: '用户持续不喝咖啡和运动饮料，订饮料选择温白水；该个人习惯不限制客户接待。', claimPatterns: { allOf: ['咖啡', '不喝|不饮|拒绝|避免', '温白水|温水|白水'] }, qualifierPatterns: [{ allOf: ['个人|用户|本人|你'] }], negation: 'required', evidenceTurns: ['n1', 'n2', 'n3', 'n4', 'n5'], audit: '核对“不喝”作用于用户和两种饮料；不能变成“喜欢咖啡”“只在今天不喝”或团队全面禁用咖啡。' }],
      forbidden: [{ semantic: '用户喜欢或常喝咖啡，或办公室/客户一律不能有咖啡。', claimPatterns: { allOf: ['咖啡'], anyOf: ['用户.*(?:喜欢|爱喝|常喝)', '(?:所有人|客户|全办公室|整个团队).*(?:禁止|一律不|不能)'], noneOf: ['并非|不是|不受|没有禁止'] }, audit: '不仅查看有没有否定字，还要看否定修饰哪个主语与谓语。' }],
      audit: ['“不喝咖啡”与“客户可以喝咖啡”必须共存，不能自动产生矛盾或替换。'],
    }],
    audit: ['饮品名称只是固定测试材料，不应引入任何生产谓词表。'],
  },
  {
    id: 'conditional-export', category: 'condition', title: '前置条件与冻结例外都必须保留', scope: { kind: 'user' },
    phases: [{
      id: 'customer-confirmation-and-freeze',
      turns: [
        { id: 'c1', user: '银杉资料导出只有拿到客户确认的字段清单，才生成正式导出文件。', assistant: '客户确认字段清单是正式导出的前置条件。' },
        { id: 'c2', user: '清单没确认时，只能做带“草稿”标记的预览，不能发正式文件。', assistant: '未确认时仅允许草稿预览。' },
        { id: 'c3', user: '如果法务冻结了这批资料，即使客户确认了，也不能导出。', assistant: '法务冻结是更严格的禁止条件。' },
        { id: 'c4', user: '正式导出通过后，文件名带上客户确认日期，便于追溯。', assistant: '正式文件的命名还需要确认日期。' },
        { id: 'c5', user: '这些是银杉资料持续使用的规则，不是只针对今天这一次。', assistant: '后续处理同类资料仍按这些条件判断。' },
      ],
      recallQuery: '客户还没确认字段清单时，可以发送银杉正式资料吗？客户确认但法务冻结呢？',
      expectations: [{ id: 'export-conditions', disposition: 'required', attribution: 'user', semantic: '银杉正式导出需客户确认字段清单且未被法务冻结；未确认只可草稿预览，冻结时即使确认也禁止导出。', claimPatterns: { allOf: ['银杉|资料导出', '客户', '确认', '字段清单|清单'] }, qualifierPatterns: [{ allOf: ['未确认|没确认|尚未确认|未经确认', '草稿|预览'] }, { allOf: ['法务', '冻结', '不能|不得|禁止|不可'] }], negation: 'preserve-exception', evidenceTurns: ['c1', 'c2', 'c3', 'c5'], audit: '必须保留必要条件与冻结例外的逻辑，不得把“客户确认”误写为充分条件；草稿不是正式导出。' }],
      forbidden: [{ semantic: '客户确认后无条件导出，或未确认也可以发送正式文件。', claimPatterns: { allOf: ['正式|导出'], anyOf: ['只要.*确认.*(?:就|即可)', '(?:未|没)确认.*(?:可以|允许).*(?:发送|正式)'], noneOf: ['未冻结|不冻结|法务|不能|不得|禁止'] }, audit: '同一句“只要确认即可”若缺冻结条件，不能因别处出现“冻结”两个字就判通过。' }],
      audit: ['无关的文件命名细节可另存，不能取代条件语义的核验。'],
    }],
    audit: ['必须用假设情景检查必要条件和例外，而不是只看四个关键词是否齐全。'],
  },
  {
    id: 'dated-location-correction', category: 'historical-correction', title: '分两次 Dream 验证带生效时间的更正', scope: { kind: 'user' },
    phases: [
      {
        id: 'initial-location',
        turns: [
          { id: 'h1', user: '从2025年3月起，我的常驻办公地点是青湾楼。', assistant: '已了解常驻办公地点和起始时间。' },
          { id: 'h2', user: '青湾楼的工位在三层，工作日通常在那里。', assistant: '工位位置与工作日安排已区分记录。' },
          { id: 'h3', user: '临时出差不代表常驻办公地点改变。', assistant: '不会因临时出差替换常驻地点。' },
          { id: 'h4', user: '我下午习惯喝无糖茶，这和办公地点无关。', assistant: '这是独立的饮品习惯。' },
          { id: 'h5', user: '以后问当前常驻地点时，可以按这条约定回答；真正搬迁我会明确更正。', assistant: '后续会以明确搬迁更正更新现状。' },
        ],
        recallQuery: '我目前常驻在哪里办公？从什么时候开始？',
        expectations: [{ id: 'initial-qingwan', disposition: 'required', attribution: 'user', semantic: '第一阶段当前常驻办公地为青湾楼，起始于2025年3月；临时出差不改变这一事实。', claimPatterns: { allOf: ['青湾楼', '2025', '3月|三月'] }, qualifierPatterns: [{ allOf: ['常驻|固定办公|长期办公'] }], negation: 'not-applicable', evidenceTurns: ['h1', 'h3', 'h5'], audit: '必须先有真实accepted digest和召回快照，再开始第二阶段，不能合并输入跳过自动替换边界。' }],
        forbidden: [{ semantic: '把临时出差当成常驻地点变化。', claimPatterns: { allOf: ['出差', '常驻'], anyOf: ['出差.*(?:自动|即).*变更'] }, audit: '这里没有第二个常驻地点，不能按新近消息推导更正。' }],
        audit: ['保存第一阶段的digest identity、revision、来源和recall，供第二阶段对照。'],
      },
      {
        id: 'explicit-relocation',
        turns: [
          { id: 'h6', user: '更正一下：从2026年11月起，我已搬到松岚楼常驻办公，青湾楼是此前的办公地点。', assistant: '这是一项有明确生效时间的常驻地点更正。' },
          { id: 'h7', user: '这次是常驻工位搬迁，不是临时出差。', assistant: '不会把它当作临时行程。' },
          { id: 'h8', user: '松岚楼的工位在二层。', assistant: '新工位在松岚楼二层。' },
          { id: 'h9', user: '青湾楼仍有仓库，所以提到仓库不表示我还在那里办公。', assistant: '仓库与常驻办公地点是不同事实。' },
          { id: 'h10', user: '下午喝无糖茶的习惯没变，旧办公地点只作为历史保留。', assistant: '保留独立习惯，并将旧地点用于历史查询。' },
        ],
        recallQuery: '我现在常驻在哪里办公，何时搬迁？青湾楼还有什么用途，喝茶习惯变了吗？',
        expectations: [
          { id: 'current-songlan', disposition: 'required', attribution: 'user', semantic: '第二阶段现常驻办公地点为松岚楼二层，从2026年11月生效，青湾楼仅为此前办公地点及仍有仓库。', claimPatterns: { allOf: ['松岚楼', '2026', '11月|十一月'] }, qualifierPatterns: [{ allOf: ['常驻|办公'] }], negation: 'not-applicable', evidenceTurns: ['h6', 'h7', 'h8'], audit: '以current applicability和相关召回核验自动更正；旧地点留在history/evidence不是失败，旧地点被当成当前办公答案才是失败。' },
          { id: 'tea-survives', disposition: 'required', attribution: 'user', semantic: '无糖茶习惯不因地点更正丢失。', claimPatterns: { allOf: ['无糖茶'] }, qualifierPatterns: [], negation: 'not-applicable', evidenceTurns: ['h4', 'h10'], audit: '检查更正只作用于有明确证据的地点事实，不删除其他独立语义。' },
        ],
        forbidden: [{ semantic: '仍把青湾楼回答为现在常驻办公地，或因为仓库存在撤销搬迁。', claimPatterns: { allOf: ['青湾楼', '办公|常驻'], anyOf: ['现在|目前|仍然|依旧'], noneOf: ['此前|原来|过去|历史|不再|曾经|旧办公'] }, audit: '机器模式只提示审计位置；必须区分历史叙述与当前真值，不要求物理删掉青湾这个词。' }],
        audit: ['第二阶段单独完成note/Dream并核revision/替代关系，不允许用用户手工编辑替代自动更正；历史asOf查询另审旧值仍有时间依据。'],
      },
    ],
    audit: ['必须先运行initial-location并归档，再运行explicit-relocation；两阶段都使用同一持续会话、相同可信scope和实际模型。'],
  },
  {
    id: 'project-release-procedure', category: 'project-procedure', title: '项目流程保留步骤顺序并隔离范围', scope: { kind: 'project', fixtureProject: 'beichen-delivery' },
    phases: [{
      id: 'release-window-policy',
      turns: [
        { id: 'p1', user: '北辰交付项目的发布流程是：先跑集成测试，再由值班同事验签，最后进入发布窗口。', assistant: '流程顺序是集成测试、验签、发布窗口。' },
        { id: 'p2', user: '集成测试失败时停止，不能绕过失败继续验签发布。', assistant: '测试失败是明确停止条件。' },
        { id: 'p3', user: '验签通过后生成变更单，把测试报告链接填进去。', assistant: '验签后的变更单需要附测试报告链接。' },
        { id: 'p4', user: '发布窗口目前是周四18点到19点；紧急修复也要先拿到当次明确批准。', assistant: '常规窗口和紧急修复的额外授权要求会分别保留。' },
        { id: 'p5', user: '这套流程只适用于北辰交付项目，不要直接套到其他项目。', assistant: '范围限定为北辰交付项目。' },
      ],
      recallQuery: '北辰项目怎么发布？测试失败能继续吗，常规窗口和紧急修复有什么要求？',
      expectations: [{ id: 'scoped-release-flow', disposition: 'required', attribution: 'project', semantic: '仅北辰项目：集成测试→值班验签→变更单含测试报告→发布窗口；测试失败停止，紧急修复须当次明确批准。', claimPatterns: { allOf: ['集成测试', '验签', '发布窗口|发布', '变更单'] }, qualifierPatterns: [{ allOf: ['失败', '停止|不能|不得'] }, { allOf: ['紧急', '批准|授权'] }], negation: 'preserve-exception', evidenceTurns: ['p1', 'p2', 'p3', 'p4', 'p5'], audit: '按原文核步骤顺序、失败停止和紧急授权，不能将步骤列齐却颠倒顺序；可信project必须由runner绑定。' }],
      forbidden: [{ semantic: '其他项目或个人全局直接使用北辰规则，或测试失败仍可直接发布。', claimPatterns: { allOf: ['发布'], anyOf: ['所有项目|其他项目也|全局规则', '(?:测试失败).*(?:仍可|可以继续|直接发布)'], noneOf: ['不得|不能|不适用|不要|不可'] }, audit: '除文字审计，还须在foreign project和没有project授权的会话实查不能召回该项目内容。' }],
      audit: ['fixtureProject是runner映射到实际临时Git项目的标识种子，不是模型可自行传入的scope凭证。'],
    }],
    audit: ['同一项目的新话题可检索；另一Git项目与纯user origin不可读取。只做同scope检索不算项目隔离验收完成。'],
  },
  {
    id: 'qualified-response-preference', category: 'preference', title: '偏好保留适用场景与优先例外', scope: { kind: 'user' },
    phases: [{
      id: 'technical-answer-exception',
      turns: [
        { id: 'r1', user: '以后评审技术方案时，我希望先给结论，再列依据。', assistant: '这是针对技术方案评审的长期表达偏好。' },
        { id: 'r2', user: '如果有紧急安全风险，先说风险和马上需要做什么，再补通常的结论。', assistant: '紧急安全风险时先给风险和即时动作。' },
        { id: 'r3', user: '比较预算和维护成本时用表格，但不要为了表格把限制条件删掉。', assistant: '成本比较可以用表格，条件仍需完整。' },
        { id: 'r4', user: '闲聊不需要每次都套这个结构。', assistant: '日常闲聊不自动套用技术评审格式。' },
        { id: 'r5', user: '这不是只对今天的回答生效；有例外时按前面说的安全风险优先。', assistant: '后续继续保留适用范围和安全例外。' },
      ],
      recallQuery: '评审技术方案应该按什么顺序回答？紧急安全风险、成本比较和闲聊分别怎样处理？',
      expectations: [{ id: 'technical-preference', disposition: 'required', attribution: 'user', semantic: '技术方案评审通常先结论后依据；紧急安全风险先风险和即时动作；成本比较用表格但保留条件；闲聊不强制该格式。', claimPatterns: { allOf: ['技术方案|技术评审|评审技术', '结论', '依据'] }, qualifierPatterns: [{ allOf: ['紧急|安全风险', '先|优先', '风险|动作'] }, { allOf: ['闲聊', '不|无需|不用'] }, { allOf: ['预算|维护成本|成本比较', '表格', '条件|限制'] }], negation: 'preserve-exception', evidenceTurns: ['r1', 'r2', 'r3', 'r4', 'r5'], audit: '须核范围和优先级，不能压成“用户所有回答都先给结论”或“任何回答都用表格”；不能因最新一句风险例外而删除一般偏好。' }],
      forbidden: [{ semantic: '把局部偏好变成所有场景的绝对要求，或遗漏安全优先例外。', claimPatterns: { allOf: ['结论|表格'], anyOf: ['任何回答|所有回答|所有场景|一律|无论.*都'], noneOf: ['不必|无需|例外|除外|安全|闲聊'] }, audit: '限定和例外即使分句保存也应在同一适用性视图中同时生效，不能只靠出现“安全”一词判合格。' }],
      audit: ['用普通技术评审、紧急安全事件、闲聊三个假设情景检查行为边界；本评测只审记忆语义，不把模型随后的成文质量一起算通过。'],
    }],
    audit: ['长期性由r1/r5原文明确支持，不能仅因重复提到结论或表格就推导全球偏好。'],
  },
] as const satisfies readonly MemorySemanticCase[]

/** Public runner name; the uppercase constant is retained for report/audit imports. */
export const memorySemanticCases: readonly MemorySemanticCase[] = MEMORY_SEMANTIC_CASES
