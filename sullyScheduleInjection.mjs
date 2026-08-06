/**
 * SullyOS schedule injection parity port.
 *
 * Source: D:/SullyOS-fork/utils/scheduleInjection.ts
 * Source SHA-256: 5cb9b0c65ffe1f60c2e75c0e601f2f3dd910066d405cbbf0f24b0cd3a2649697
 *
 * Prompt-bearing strings below are copied verbatim. Do not edit them independently;
 * update from SullyOS and refresh the parity regression together.
 */

/** 意识流独白按一天三档取：早 / 午 / 晚。 */
export function getFlowNarrativeKey(hour) {
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
}

/** 几点之前算「还在前一夜里」。凌晨 0-5 点属于昨晚的尾巴，不是今天的早晨。 */
const PRE_DAWN_END_HOUR = 5;

/** 当前时刻落在哪一条日程上，以及紧接着的下一条。都可能为 null（表还没开始 / 表是空的）。 */
export const resolveScheduleSlots = (schedule, now) => {
    if (!schedule?.slots?.length) return { current: null, next: null };
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    for (let i = schedule.slots.length - 1; i >= 0; i--) {
        const [h, m] = schedule.slots[i].startTime.split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
        if (currentMinutes >= h * 60 + m) {
            return {
                current: schedule.slots[i],
                next: i < schedule.slots.length - 1 ? schedule.slots[i + 1] : null,
            };
        }
    }
    // 今天第一条还没到点：没有「当前」，只有「稍后先做什么」。
    return { current: null, next: schedule.slots[0] };
};

/**
 * 构建日程注入文本
 *
 * 两段式，独立叠加：
 * 1) 当前时段硬事实——每轮都注入，不受 evolvedNarrative 影响
 * 2) 意识流独白——evolvedNarrative > flowNarrative > 当前 slot innerThought
 */
export const buildScheduleInjection = (
    schedule,
    evolvedNarrative,
    now = new Date(),
) => {
    if (!schedule || !schedule.slots || schedule.slots.length === 0) return '';
    const { current: currentSlot, next: nextSlot } = resolveScheduleSlots(schedule, now);

    // 凌晨还没轮到今天第一条日程时，人其实还在昨晚里没睡。主动消息经常在这个点触发，
    // 按「今天刚要开始」写，半夜一点的角色就会顶着清晨的心境说话。
    const isPreDawnCarryOver = !currentSlot && now.getHours() < PRE_DAWN_END_HOUR;

    // 1. 当前时段硬事实（每轮独立注入）
    let slotHeader = '';
    if (currentSlot) {
        slotHeader = `当前时段：${currentSlot.startTime} 你正在${currentSlot.activity}`;
        if (currentSlot.location) slotHeader += `（${currentSlot.location}）`;
        if (nextSlot) slotHeader += `\n之后安排：${nextSlot.startTime} ${nextSlot.activity}`;
        slotHeader += '\n';
    } else if (nextSlot) {
        slotHeader = isPreDawnCarryOver
            ? `夜深了，今天的安排还没开始，最早的一件是${nextSlot.activity}（${nextSlot.startTime}）\n`
            : `今天还没开始活动，稍后先${nextSlot.activity}（${nextSlot.startTime}）\n`;
    }

    // 2. 意识流独白
    let narrative = '';
    if (evolvedNarrative) {
        narrative = evolvedNarrative;
    } else if (schedule.flowNarrative && Object.keys(schedule.flowNarrative).length > 0) {
        // 前一夜的延续取「晚」档；其余照一天三档走。
        const key = isPreDawnCarryOver ? 'evening' : getFlowNarrativeKey(now.getHours());
        narrative = schedule.flowNarrative[key]
            || schedule.flowNarrative['evening']
            || schedule.flowNarrative['afternoon']
            || schedule.flowNarrative['morning']
            || '';
    } else if (currentSlot?.innerThought) {
        narrative = currentSlot.innerThought;
    }

    // 3. 拼接：硬事实 → 意识流（可选）
    const preamble = `此刻你的心中盘旋着这些想法……\n`;
    const footnote = `\n（不是台词，不用说出口——让它影响你的语气和情绪就好。）`;

    let out = slotHeader;
    if (narrative) {
        out += preamble + narrative + footnote;
    }
    out += '\n';
    return out;
};
