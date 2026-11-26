"use strict";

// =====================================================
// Egyxos rule-based chatbot: predefined replies
//
// Every sentence Egyxos can say is written here, in Egyptian
// Arabic and in English. Replies avoid gendered verb forms so
// they read correctly for any visitor.
// =====================================================

const AR_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];
const AR_WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const EN_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "2026-11-27" -> "الجمعة 27 نوفمبر 2026" / "Friday, 27 November 2026" */
function formatDate(iso, lang) {
  const [y, m, d] = iso.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return lang === "en"
    ? `${EN_WEEKDAYS[weekday]}, ${d} ${EN_MONTHS[m - 1]} ${y}`
    : `${AR_WEEKDAYS[weekday]} ${d} ${AR_MONTHS[m - 1]} ${y}`;
}

const firstName = (name) => String(name).split(" ")[0];

const DATE_HINT = {
  ar: "اكتب مثلًا: بكرة، الجمعة الجاية، أو 27 نوفمبر.",
  en: "For example: tomorrow, next Friday, or 27 November.",
};

// Each question has an optional friendly lead-in ("Great!") that is dropped
// when the reply already starts with an explanation.
const ASK = {
  date: {
    ar: { lead: "", q: `تحب تزور المتحف إمتى؟ ${DATE_HINT.ar}` },
    en: { lead: "", q: `When would you like to visit the museum? ${DATE_HINT.en}` },
  },
  visitors: {
    ar: { lead: "تمام! ", q: "كام شخص هيزور المتحف؟ (من 1 لـ 10)" },
    en: { lead: "Great! ", q: "How many people will visit the museum? (1 to 10)" },
  },
  name: {
    ar: { lead: "حلو! ", q: "الحجز هيكون باسم مين؟" },
    en: { lead: "Nice! ", q: "What name should the booking be under?" },
  },
};

const TEXT = {
  // The booking page already shows its own greeting from Egyxos, so this
  // only has to move the conversation on.
  welcome: {
    ar: `أهلًا بيك! ${ASK.date.ar.q}`,
    en: `Hello! ${ASK.date.en.q}`,
  },
  unknown: {
    ar: "معلش، مفهمتش قصدك. ",
    en: "Sorry, I didn't get that. ",
  },
  pastDate: {
    ar: "التاريخ ده عدّى. اختار تاريخ من النهارده وطالع. ",
    en: "That date has already passed. Please choose today or a later date. ",
  },
  farDate: {
    ar: "ممكن تحجز لحد سنة قدام بس. اختار تاريخ أقرب. ",
    en: "You can book up to one year ahead. Please choose an earlier date. ",
  },
  invalidDate: {
    ar: "التاريخ ده مش صحيح. ",
    en: "That isn't a valid date. ",
  },
  severalDates: {
    ar: "لقيت أكتر من تاريخ في رسالتك. ",
    en: "I found more than one date in your message. ",
  },
  dateNeedsMore: {
    ar: "الرقم ده لوحده مش كفاية أفهم منه التاريخ. ",
    en: "A number on its own isn't enough for me to tell the date. ",
  },
  badVisitors: {
    ar: "عدد الزوار لازم يكون من 1 لـ 10. ",
    en: "The number of visitors must be between 1 and 10. ",
  },
  groupVisitors: {
    ar: "قولي العدد الإجمالي للزوار (بالأطفال) كرقم واحد من 1 لـ 10. ",
    en: "Please tell me the total number of visitors, children included, as one number from 1 to 10. ",
  },
  severalCounts: {
    ar: "لقيت أكتر من رقم لعدد الزوار. ",
    en: "I found more than one visitor count. ",
  },
  badName: {
    ar: "الاسم لازم يكون حروف بس (من 2 لـ 100 حرف) من غير أرقام أو رموز. ",
    en: "The name should use letters only (2 to 100 characters), with no numbers or symbols. ",
  },
  whatToChange: {
    ar: "تحب تغيّر إيه؟ التاريخ، عدد الزوار، ولا الاسم؟",
    en: "What would you like to change: the date, the number of visitors, or the name?",
  },
  notReady: {
    ar: "لسه محتاج شوية بيانات قبل ما أأكد الحجز. ",
    en: "I still need a few details before I can confirm the booking. ",
  },
  nothingToCancel: {
    ar: "مفيش حجز شغال أقدر ألغيه دلوقتي. لو عايز تبدأ حجز جديد، قولي تحب تزور المتحف إمتى.",
    en: "There's no booking in progress to cancel. To start a new one, tell me when you'd like to visit.",
  },
  cancelled: {
    ar: "تمام، ألغيت طلب الحجز الحالي. لو عايز تبدأ حجز جديد، هنبدأ من الأول.",
    en: "Your current booking request has been cancelled. You can start a new booking any time.",
  },
  alreadyDone: {
    ar: "الحجز ده اتأكد قبل كده. لو عايز تعمل حجز جديد، ابدأ محادثة جديدة.",
    en: "This booking has already been confirmed. To make a new one, please start a new conversation.",
  },
  alreadyCancelled: {
    ar: "طلب الحجز ده اتلغى. ابدأ محادثة جديدة لو عايز تعمل حجز جديد.",
    en: "This booking request was cancelled. Please start a new conversation to make a new booking.",
  },
};

function changeAck(fields, lang) {
  const names = {
    date: { ar: "التاريخ", en: "the date" },
    visitors: { ar: "عدد الزوار", en: "the number of visitors" },
    name: { ar: "الاسم", en: "the name" },
  };
  const list = fields.map((f) => names[f][lang]);
  return lang === "en"
    ? `Sure, let's change ${list.join(" and ")}. `
    : `تمام، نغيّر ${list.join(" و")}. `;
}

function review({ name, date, visitors }, lang) {
  const when = formatDate(date, lang);
  return lang === "en"
    ? `Thanks, ${firstName(name)}! Here are your booking details:\n- Date: ${when}\n- Visitors: ${visitors}\n- Name: ${name}\n\nThis is a demo booking, not an official museum ticket.\n\nWould you like to confirm the booking, or change anything?`
    : `تمام يا ${firstName(name)}! دي تفاصيل حجزك:\n- التاريخ: ${when}\n- عدد الزوار: ${visitors}\n- الاسم: ${name}\n\nده حجز تجريبي مش تذكرة رسمية للمتحف.\n\nتحب تأكد الحجز ولا تعدل حاجة؟`;
}

function confirmed(booking, lang) {
  const when = formatDate(booking.visit_date, lang);
  return lang === "en"
    ? `Your booking has been recorded!\nBooking reference: ${booking.booking_reference}\n- Name: ${booking.visitor_name}\n- Date: ${when}\n- Visitors: ${booking.ticket_count}\n\nThis is a demo booking, not an official museum ticket.`
    : `تم تسجيل حجزك بنجاح!\nرقم الحجز: ${booking.booking_reference}\n- الاسم: ${booking.visitor_name}\n- التاريخ: ${when}\n- عدد الزوار: ${booking.ticket_count}\n\nده حجز تجريبي مش تذكرة رسمية للمتحف.`;
}

const t = (key, lang) => TEXT[key][lang === "en" ? "en" : "ar"];
/** The question for a missing field. `withLead` adds the friendly lead-in. */
const ask = (field, lang, withLead = true) => {
  const entry = ASK[field][lang === "en" ? "en" : "ar"];
  return (withLead ? entry.lead : "") + entry.q;
};

module.exports = { formatDate, t, ask, changeAck, review, confirmed };