// 导出高光的文案方案。可随时新增/调整,用于现场试哪种口吻更有传播欲。
// overlay: 录制画面里的实时覆盖层; card: 结尾成绩卡。
export const HIGHLIGHT_COPY = {
  challenge: {
    name: '挑战向',
    overlay: {
      topTitle: '不服来战',
      emptyTier: '你能拿几分？',
      tiers: { PERFECT: '封神瞬间', GREAT: '有点东西', GOOD: '舞感在线', MISS: '下次一定' },
    },
    card: {
      eyebrow: 'DANCE ARENA',
      gradeTitles: { S: '封神舞者', A: '有点东西', B: '舞感在线', C: '重在参与', D: '下次一定' },
      scoreLine: '得分 {score} · 最大连击 {combo}',
      tagline: '评论区晒出你的评级 👇',
    },
  },
  attitude: {
    name: '态度向',
    overlay: {
      topTitle: '跳就完了',
      emptyTier: '别管跳得怎么样',
      tiers: { PERFECT: '就是这一下', GREAT: '稳了', GOOD: '还行', MISS: '无所谓' },
    },
    card: {
      eyebrow: 'DANCE ARENA',
      gradeTitles: { S: '人生第一支舞', A: '跳就完了', B: '舞感在线', C: '渐入佳境', D: '重在参与' },
      scoreLine: '得分 {score} · 最大连击 {combo}',
      tagline: '零基础也能跳，你只是还没开始',
    },
  },
  showoff: {
    name: '炫耀向',
    overlay: {
      topTitle: '本场封神',
      emptyTier: '不服来战',
      tiers: { PERFECT: '全程没断', GREAT: '手都没停', GOOD: '稳住', MISS: '故意的' },
    },
    card: {
      eyebrow: 'DANCE ARENA · 高光认证',
      gradeTitles: { S: '本场封神', A: '天选舞者', B: '稳定输出', C: '潜力股', D: '下次反杀' },
      scoreLine: '得分 {score} · 最大连击 {combo}',
      tagline: 'S 级认证 · 不服来战',
    },
  },
  meme: {
    name: '玩梗向',
    overlay: {
      topTitle: '前方高能',
      emptyTier: '教练：带不动',
      tiers: { PERFECT: '教练都看呆了', GREAT: '有内味了', GOOD: '就这？还行', MISS: '教练：带不动' },
    },
    card: {
      eyebrow: 'DANCE ARENA · 高光',
      gradeTitles: { S: '就这？也还行', A: '有点东西', B: '凑合看吧', C: '我是来搞笑的', D: '教练哭了' },
      scoreLine: '得分 {score} · 最大连击 {combo}',
      tagline: '下次一定',
    },
  },
};

export const DEFAULT_COPY = 'challenge';

export function copyFor(id) {
  return HIGHLIGHT_COPY[id] || HIGHLIGHT_COPY[DEFAULT_COPY];
}

export function copyOptions() {
  return Object.entries(HIGHLIGHT_COPY).map(([id, c]) => ({ id, name: c.name }));
}

export function renderScoreLine(template, score, combo) {
  return template.replace('{score}', score).replace('{combo}', combo);
}
