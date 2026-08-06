const clean = (value) => value === undefined || value === null ? "" : String(value).trim();

const VR_ROOM_NAMES = {
  library: "图书馆",
  music: "听歌房",
  guestbook: "留言簿",
  gym: "娱乐室",
  theater: "剧院",
  signal: "信号坠落处",
  postoffice: "邮局",
  cafe: "糯米鸡研发中心",
};

function bounded(value, limit) {
  const text = clean(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function firstUsefulLine(content) {
  return clean(content).split(/\r?\n/).map((line) => line.trim()).find((line) => line && !/^「彼方\s*[·・]/.test(line)) || "";
}

function roomFromContent(content) {
  const match = clean(content).match(/^「彼方\s*[·・]\s*([^」]+)」/);
  return match ? clean(match[1]) : "";
}

function occurredAtValue(spec = {}) {
  const parsed = new Date(spec.occurredAt ?? spec.timestamp ?? spec.createdAt ?? Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function deriveActivityStatePatch(spec = {}) {
  const metadata = spec.metadata && typeof spec.metadata === "object" ? spec.metadata : {};
  const content = clean(spec.content || spec.text || spec.body || "");
  const roomId = clean(spec.room || metadata.room);
  const parsedRoomName = roomFromContent(content);
  const roomName = clean(spec.roomName || metadata.roomName || VR_ROOM_NAMES[roomId] || parsedRoomName);
  const explicitLocation = clean(spec.location || metadata.location);
  const location = explicitLocation || (roomName ? `《彼方》·${roomName}` : "");
  const summary = bounded(spec.summary || metadata.activity || firstUsefulLine(content) || content, 1000);
  const explicitCurrent = clean(spec.currentActivity || spec.name || metadata.currentActivity || metadata.activityName);
  const currentName = bounded(explicitCurrent || (roomName ? `在《彼方》的${roomName}停留` : summary), 240);
  const occurredAt = occurredAtValue(spec);
  const activityId = clean(spec.activityId || spec.messageId || spec.sourceId || spec.id);

  const patch = {
    activity: {
      name: currentName || "自由活动",
      ...(location ? { location } : {}),
      startedAt: occurredAt,
      updatedAt: occurredAt,
      ...(activityId ? { activityId } : {}),
    },
    lastActivity: {
      ...(activityId ? { activityId } : {}),
      summary,
      ...(location ? { location } : {}),
      occurredAt,
      surface: "activity",
    },
  };
  if (location) patch.location = location;
  if (roomId) patch.vrState = { enabled: true, currentRoom: roomId, lastActiveAt: Date.parse(occurredAt) };
  return patch;
}
