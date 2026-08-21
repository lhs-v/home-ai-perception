/**
 * 상황 융합 + 개입 판단 규칙엔진.
 *
 * 12개 클립 중 4개가 무작위로 뽑히므로 495가지 조합이 나온다.
 * 조합마다 사람이 써둘 수는 없으니, 이벤트의 타입·태그·위협도로
 * 시나리오 규칙을 매칭하고 점수를 합성한다.
 */

/**
 * 이벤트가 실제 상황에서 일어나는 자연스러운 순서.
 * 1막 재생 순서와 통합 서술의 인과를 맞추기 위해 쓴다.
 * (접근 → 침입 → 이동 → 이탈 → 생활 → 이상 → 경보)
 */
const SEQUENCE = {
  forced_entry: 12,
  glass_break: 14,
  door_unlock: 18,   // 파손이 먼저 나야 "깨고 열었다"는 서술과 재생 순서가 맞는다
  footsteps: 22,
  theft: 26,
  door_slam: 30,
  appliance: 40,
  pet_activity: 44,
  pet_vocal: 46,
  impact_fall: 52,
  infant_distress: 56,
  alarm_fire: 62,
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 이야기 순서대로 정렬한다. 같은 순위면 원래 뽑힌 순서를 유지한다. */
export function orderByStory(clips) {
  return clips
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const sa = SEQUENCE[a.c.semantics.event_type] ?? 35;
      const sb = SEQUENCE[b.c.semantics.event_type] ?? 35;
      return sa - sb || a.i - b.i;
    })
    .map((x) => x.c);
}

/** match 블록 하나를 검사한다. 지정된 필드만 본다. */
function matches(match, ctx) {
  if (!match) return { ok: true, weight: 0 };
  let weight = 0;

  if (match.all_types) {
    if (!match.all_types.every((t) => ctx.types.has(t))) return { ok: false };
    weight += match.all_types.length * 3;
  }
  if (match.any_types) {
    const hit = match.any_types.filter((t) => ctx.types.has(t)).length;
    if (hit < (match.min_count ?? 1)) return { ok: false };
    weight += 2;
  }
  if (match.all_tags) {
    if (!match.all_tags.every((t) => ctx.tags.has(t))) return { ok: false };
    weight += match.all_tags.length * 2;
  }
  if (match.any_tags) {
    const hit = match.any_tags.filter((t) => ctx.tags.has(t)).length;
    if (hit < (match.min_count ?? 1)) return { ok: false };
    weight += 1;
  }
  if (match.none_tags) {
    if (match.none_tags.some((t) => ctx.tags.has(t))) return { ok: false };
    weight += match.none_tags.length;
  }
  if (match.min_threat != null) {
    if (ctx.maxThreat < match.min_threat) return { ok: false };
    weight += 1;
  }
  if (match.max_threat != null) {
    if (ctx.maxThreat > match.max_threat) return { ok: false };
    weight += 1;
  }
  return { ok: true, weight };
}

/**
 * 4개 클립을 하나의 상황으로 융합한다.
 * @param {Array} clips  주석이 붙은 클립 4개 (이야기 순서로 정렬된 상태)
 * @param {Object} spec  fusion.json (scenarios / decision_bands / fallback)
 */
export function fuse(clips, spec) {
  const types = new Set(clips.map((c) => c.semantics.event_type));
  const tags = new Set(clips.flatMap((c) => c.semantics.tags));
  const threats = clips.map((c) => c.semantics.threat);
  const maxThreat = Math.max(...threats);
  const ctx = { types, tags, maxThreat, clips };

  // ── 시나리오 매칭: priority 우선, 같으면 조건이 더 구체적인 쪽이 이긴다
  let best = null;
  for (const s of spec.scenarios) {
    const m = matches(s.match, ctx);
    if (!m.ok) continue;
    const rank = s.priority * 1000 + m.weight;
    if (!best || rank > best.rank) best = { scenario: s, rank, weight: m.weight };
  }

  const sc = best ? best.scenario : { ...spec.fallback, id: 'fallback', name_ko: '일반 상황', threat_bonus: 0 };

  // ── 점수 합성
  const dangerous = clips.filter((c) => c.semantics.threat >= 45).length;
  const night = clips.filter((c) => c.visual.time_of_day === 'night').length > 0;
  const residentOnly = tags.has('resident_activity') && !tags.has('intrusion') && !tags.has('fire');

  // 가장 위험한 신호 하나가 점수를 독점하면 어떤 조합이든 "즉시 개입"이 된다.
  // 두 번째 신호까지 섞어야 "혼자 튀는 소리"와 "서로 뒷받침하는 소리"가 갈린다.
  const sorted = [...threats].sort((x, y) => y - x);
  let score = sorted[0] * 0.7 + (sorted[1] || 0) * 0.3;
  // 가중치를 그대로 더하면 상한을 넘겨 회차의 절반이 100 에 붙는다.
  // 게이지가 항상 꽉 차 있으면 위험도라는 축이 아무 말도 하지 않게 된다.
  score += (sc.threat_bonus || 0) * 0.55;
  score += Math.max(0, dangerous - 1) * 4;      // 위험 신호가 겹치면 가중
  if (night && dangerous > 0) score += 4;        // 야간의 이상 신호는 더 무겁게
  if (residentOnly) score -= 10;                 // 거주자 활동이 확인되면 완화
  score = clamp(Math.round(score), 0, 100);

  // ── 라벨과 점수가 어긋나지 않게, 매칭된 시나리오의 판단을 점수 구간으로 강제한다.
  //    한 판단에 여러 구간이 걸쳐 있으므로(개입 = 60~84, 85~100) 전체 범위를 써야
  //    "즉시 개입"이 영영 안 나오는 일이 생기지 않는다.
  const bands = [...spec.decision_bands].sort((a, b) => a.min - b.min);
  const bandFor = (v) => bands.find((b) => v >= b.min && v <= b.max) || bands[bands.length - 1];
  if (best) {
    const same = bands.filter((b) => b.decision === sc.decision);
    if (same.length) {
      const lo = Math.min(...same.map((b) => b.min));
      const hi = Math.max(...same.map((b) => b.max));
      score = clamp(score, lo, hi);
    }
  }
  // 매칭이 없으면 고정된 fallback 판단을 강요하지 않고 점수가 말하게 둔다
  const band = bandFor(score);

  // ── 신뢰도: 규칙이 구체적일수록, 서로 뒷받침하는 신호가 많을수록 높다
  const corroboration = clips.length - new Set(clips.map((c) => c.semantics.event_type)).size;
  let confidence = 63 + (best ? Math.min(20, best.weight * 2) : -8) + corroboration * 3;
  if (types.size >= 4) confidence += 4;
  confidence = clamp(Math.round(confidence), 41, 97);

  return {
    scenario: sc,
    name: sc.name_ko,
    narrative: sc.narrative,
    reasons: sc.reasons || [],
    actions: sc.actions || [],
    decision: band.decision,
    label: band.label_ko,
    tone: band.tone,
    score,
    confidence,
    matched: Boolean(best),
    signals: { maxThreat, dangerous, night, residentOnly, types: [...types], tags: [...tags] },
  };
}

/** 판단 톤별 링 색상(HSL). 색이 곧 상태다. */
export const TONE_TINT = {
  critical: { h: 6, s: 88, l: 60 },
  warning: { h: 36, s: 95, l: 58 },
  calm: { h: 168, s: 62, l: 52 },
};

/** 청취 상태의 기본색. 모든 색 전환의 출발점이다. */
export const LISTEN_TINT = { h: 205, s: 92, l: 62 };

/**
 * 판단색을 t 만큼의 강도로 낸다.
 *
 * 색상(hue)은 보간하지 않는다. 파랑(205°)에서 호박(36°)으로 가는 최단 경로가
 * 초록(121°)을 지나는데, 초록은 "안전"이라 경고의 정반대 신호를 잠깐 띄운다.
 * 위험(6°)으로 가는 길은 보라를 지나 아예 다른 뜻이 된다.
 * 그래서 색상은 처음부터 판단색으로 고정하고 채도·명도만 끌어올린다 —
 * 결론이 무슨 색인지는 일찍 알리되, 얼마나 강한지는 판단 순간에 도착한다.
 * @param {number} t 0 이면 눌린 판단색, 1 이면 온전한 판단색
 */
export function mixTint(tone, t) {
  const to = TONE_TINT[tone] || LISTEN_TINT;
  return {
    h: to.h,
    s: to.s * (0.55 + 0.45 * t),
    l: to.l * (0.86 + 0.14 * t),
  };
}
