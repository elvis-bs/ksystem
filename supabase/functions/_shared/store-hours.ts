type StoreHours = {
  enabled?: unknown;
  open?: unknown;
  close?: unknown;
};

type StoreSettings = {
  mode?: unknown;
  timeZone?: unknown;
  hours?: unknown;
};

const timeZones = ["America/Sao_Paulo", "America/Manaus", "America/Rio_Branco", "America/Noronha"];
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekdayNames = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

function timeInMinutes(value: unknown): number {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return -1;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function validHours(value: unknown): StoreHours | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as StoreHours;
  const start = timeInMinutes(entry.open);
  const end = timeInMinutes(entry.close);
  return entry.enabled === true && start >= 0 && end >= 0 && start !== end ? entry : null;
}

export function storeAvailability(settings: StoreSettings | undefined, now = new Date()): {
  open: boolean;
  nextOpening: string | null;
} {
  const hours = Array.isArray(settings?.hours) ? settings.hours : [];
  const timeZone = timeZones.includes(String(settings?.timeZone)) ? String(settings?.timeZone) : "America/Sao_Paulo";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: string) => parts.find(item => item.type === type)?.value || "";
  const day = weekdays.indexOf(part("weekday"));
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  if (day < 0 || !Number.isFinite(minute)) throw new Error("Could not determine the store's local time.");

  const today = validHours(hours[day]);
  const yesterday = validHours(hours[(day + 6) % 7]);
  const todayStart = timeInMinutes(today?.open);
  const todayEnd = timeInMinutes(today?.close);
  const yesterdayStart = timeInMinutes(yesterday?.open);
  const yesterdayEnd = timeInMinutes(yesterday?.close);
  const scheduledOpen = !!today && minute >= todayStart && (todayStart > todayEnd || minute < todayEnd)
    || !!yesterday && yesterdayStart > yesterdayEnd && minute < yesterdayEnd;

  let nextOpening: string | null = null;
  for (let offset = 0; offset <= 7; offset++) {
    const openingDay = (day + offset) % 7;
    const entry = validHours(hours[openingDay]);
    if (!entry || (offset === 0 && timeInMinutes(entry.open) <= minute)) continue;
    const label = offset === 0 ? "hoje" : offset === 1 ? "amanhã" : weekdayNames[openingDay];
    nextOpening = `${label} às ${entry.open}`;
    break;
  }

  return {
    open: settings?.mode === "open" || (settings?.mode !== "closed" && scheduledOpen),
    nextOpening
  };
}
