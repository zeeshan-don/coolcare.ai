// api/_lib/demo-data.js
// Realistic demo data for CoolCare AI Demo Mode.
// All data is fabricated — no real customers, shops, or personal info is used.
// Every demo session gets a fresh copy of this data.

const DEMO = {
  // ── Demo Shop ─────────────────────────────────────────────────────────────
  shop: {
    shop_name: "CoolCare Demo Services",
    owner_name: "Alex Demo",
    email: "demo@coolcare.demo",
    mobile: "+15551234567",
    address: "123 Tech Park, Sector 5",
    city: "San Francisco",
    service_areas: ["San Francisco", "Oakland", "Palo Alto", "San Jose"],
    services_offered: [
      "AC Repair & Service",
      "Refrigerator Repair",
      "Washing Machine Repair",
      "Microwave Repair",
      "Geyser Repair",
      "TV Repair",
    ],
    logo_url: "/demo-logo.svg",
    language: "en",
    timezone: "America/Los_Angeles",
    currency: "USD",
    business_hours: {
      mon: { open: "08:00", close: "20:00" },
      tue: { open: "08:00", close: "20:00" },
      wed: { open: "08:00", close: "20:00" },
      thu: { open: "08:00", close: "20:00" },
      fri: { open: "08:00", close: "20:00" },
      sat: { open: "09:00", close: "18:00" },
      sun: { open: "10:00", close: "16:00" },
    },
    whatsapp_number: "+15559876543",
  },

  // ── AI Settings ────────────────────────────────────────────────────────────
  ai_settings: {
    greeting_message:
      "👋 Welcome to CoolCare Demo Services! I'm your AI assistant. How can I help you with your appliance today?",
    fallback_response:
      "I'm sorry, I couldn't understand that. Let me transfer you to a human agent. Alternatively, you can call us directly.",
    knowledge_base:
      "We service all major brands: Samsung, LG, Whirlpool, GE, Bosch, Kenmore, Frigidaire, Maytag. Our standard service charge is $49 for diagnosis, and parts are extra. Most repairs are completed within 24 hours. We offer a 30-day warranty on all repairs.",
    transfer_to_human: true,
    working_days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    supported_services: [
      "AC Repair & Service",
      "Refrigerator Repair",
      "Washing Machine Repair",
      "Microwave Repair",
      "Geyser Repair",
      "TV Repair",
      "Dishwasher Repair",
      "Dryer Repair",
      "Oven Repair",
    ],
  },

  // ── Technicians (8) ──────────────────────────────────────────────────────
  technicians: [
    {
      name: "Mike Johnson",
      phone: "+15551111111",
      email: "mike@demo.coolcare",
      specialization: ["AC Repair", "Refrigerator Repair", "HVAC"],
      active: true,
      rating: 4.8,
      jobs_completed: 142,
    },
    {
      name: "Sarah Chen",
      phone: "+15552222222",
      email: "sarah@demo.coolcare",
      specialization: ["Washing Machine Repair", "Dryer Repair", "Dishwasher Repair"],
      active: true,
      rating: 4.9,
      jobs_completed: 98,
    },
    {
      name: "David Martinez",
      phone: "+15553333333",
      email: "david@demo.coolcare",
      specialization: ["TV Repair", "Microwave Repair", "Electronics"],
      active: true,
      rating: 4.7,
      jobs_completed: 76,
    },
    {
      name: "Emily Wilson",
      phone: "+15554444444",
      email: "emily@demo.coolcare",
      specialization: ["Geyser Repair", "Oven Repair", "Plumbing"],
      active: true,
      rating: 4.6,
      jobs_completed: 54,
    },
    {
      name: "James Brown",
      phone: "+15555555555",
      email: "james@demo.coolcare",
      specialization: ["AC Repair", "Refrigerator Repair", "General Appliance"],
      active: true,
      rating: 4.5,
      jobs_completed: 120,
    },
    {
      name: "Lisa Anderson",
      phone: "+15556666666",
      email: "lisa@demo.coolcare",
      specialization: ["Washing Machine Repair", "Dishwasher Repair", "Dryer Repair"],
      active: true,
      rating: 4.9,
      jobs_completed: 87,
    },
    {
      name: "Robert Taylor",
      phone: "+15557777777",
      email: "robert@demo.coolcare",
      specialization: ["AC Repair", "Refrigerator Repair", "Microwave Repair"],
      active: true,
      rating: 4.4,
      jobs_completed: 65,
    },
    {
      name: "Amanda Lee",
      phone: "+15558888888",
      email: "amanda@demo.coolcare",
      specialization: ["TV Repair", "Electronics", "General Appliance"],
      active: true,
      rating: 4.7,
      jobs_completed: 43,
    },
  ],

  // ── Customers (12) ───────────────────────────────────────────────────────
  customers: [
    { name: "John Williams", phone: "+16501111111", city: "San Francisco", total_visits: 5, total_spent: 1245 },
    { name: "Maria Garcia", phone: "+16502222222", city: "Oakland", total_visits: 3, total_spent: 678 },
    { name: "Robert Kim", phone: "+16503333333", city: "Palo Alto", total_visits: 2, total_spent: 450 },
    { name: "Jennifer Lee", phone: "+16504444444", city: "San Francisco", total_visits: 4, total_spent: 890 },
    { name: "Thomas Brown", phone: "+16505555555", city: "San Jose", total_visits: 1, total_spent: 320 },
    { name: "Patricia Davis", phone: "+16506666666", city: "Oakland", total_visits: 6, total_spent: 1560 },
    { name: "Michael Wilson", phone: "+16507777777", city: "San Francisco", total_visits: 2, total_spent: 540 },
    { name: "Sarah Johnson", phone: "+16508888888", city: "Palo Alto", total_visits: 3, total_spent: 780 },
    { name: "Daniel Martinez", phone: "+16509999999", city: "San Jose", total_visits: 1, total_spent: 190 },
    { name: "Lisa Anderson", phone: "+16501010101", city: "Oakland", total_visits: 2, total_spent: 410 },
    { name: "Kevin Taylor", phone: "+16501111112", city: "San Francisco", total_visits: 3, total_spent: 920 },
    { name: "Amanda White", phone: "+16501111113", city: "Palo Alto", total_visits: 1, total_spent: 275 },
  ],

  // ── Bookings (30) ─────────────────────────────────────────────────────────
  bookings: [
    // Completed jobs (15)
    { customerIdx: 0, techIdx: 0, status: "completed", service: "AC Repair & Service", area: "San Francisco", cost: 320, created_days_ago: 2, urgency: "urgent" },
    { customerIdx: 1, techIdx: 1, status: "completed", service: "Washing Machine Repair", area: "Oakland", cost: 240, created_days_ago: 3, urgency: "today" },
    { customerIdx: 2, techIdx: 2, status: "completed", service: "TV Repair", area: "Palo Alto", cost: 180, created_days_ago: 4, urgency: "tomorrow" },
    { customerIdx: 3, techIdx: 3, status: "completed", service: "Geyser Repair", area: "San Francisco", cost: 150, created_days_ago: 5, urgency: "urgent" },
    { customerIdx: 4, techIdx: 4, status: "completed", service: "Refrigerator Repair", area: "San Jose", cost: 420, created_days_ago: 6, urgency: "today" },
    { customerIdx: 5, techIdx: 5, status: "completed", service: "Dishwasher Repair", area: "Oakland", cost: 290, created_days_ago: 7, urgency: "tomorrow" },
    { customerIdx: 6, techIdx: 6, status: "completed", service: "Microwave Repair", area: "San Francisco", cost: 130, created_days_ago: 8, urgency: "today" },
    { customerIdx: 0, techIdx: 1, status: "completed", service: "Dryer Repair", area: "San Francisco", cost: 200, created_days_ago: 10, urgency: "tomorrow" },
    { customerIdx: 7, techIdx: 2, status: "completed", service: "AC Repair & Service", area: "Palo Alto", cost: 350, created_days_ago: 11, urgency: "urgent" },
    { customerIdx: 3, techIdx: 3, status: "completed", service: "Oven Repair", area: "San Francisco", cost: 180, created_days_ago: 12, urgency: "today" },
    { customerIdx: 8, techIdx: 4, status: "completed", service: "Refrigerator Repair", area: "San Jose", cost: 380, created_days_ago: 14, urgency: "tomorrow" },
    { customerIdx: 9, techIdx: 0, status: "completed", service: "AC Installation", area: "Oakland", cost: 500, created_days_ago: 15, urgency: "today" },
    { customerIdx: 5, techIdx: 5, status: "completed", service: "Washing Machine Repair", area: "Oakland", cost: 220, created_days_ago: 16, urgency: "urgent" },
    { customerIdx: 10, techIdx: 6, status: "completed", service: "AC Repair & Service", area: "San Francisco", cost: 300, created_days_ago: 18, urgency: "tomorrow" },
    { customerIdx: 11, techIdx: 7, status: "completed", service: "TV Repair", area: "Palo Alto", cost: 160, created_days_ago: 20, urgency: "today" },

    // Assigned / In-progress (6)
    { customerIdx: 0, techIdx: 0, status: "on_the_way", service: "AC Repair & Service", area: "San Francisco", cost: null, created_days_ago: 0, urgency: "urgent" },
    { customerIdx: 3, techIdx: 1, status: "assigned", service: "Washing Machine Repair", area: "San Francisco", cost: null, created_days_ago: 0, urgency: "today" },
    { customerIdx: 6, techIdx: 2, status: "arrived", service: "Refrigerator Repair", area: "San Francisco", cost: null, created_days_ago: 0, urgency: "urgent" },
    { customerIdx: 5, techIdx: 5, status: "on_the_way", service: "Dishwasher Repair", area: "Oakland", cost: null, created_days_ago: 0, urgency: "today" },
    { customerIdx: 7, techIdx: 3, status: "assigned", service: "Geyser Repair", area: "Palo Alto", cost: null, created_days_ago: 1, urgency: "tomorrow" },
    { customerIdx: 2, techIdx: 7, status: "arrived", service: "Microwave Repair", area: "Palo Alto", cost: null, created_days_ago: 0, urgency: "urgent" },

    // Open / Pending (5)
    { customerIdx: 10, techIdx: null, status: "open", service: "AC Installation", area: "San Francisco", cost: null, created_days_ago: 0, urgency: "tomorrow" },
    { customerIdx: 1, techIdx: null, status: "open", service: "Refrigerator Repair", area: "Oakland", cost: null, created_days_ago: 1, urgency: "today" },
    { customerIdx: 4, techIdx: null, status: "open", service: "Washing Machine Repair", area: "San Jose", cost: null, created_days_ago: 0, urgency: "urgent" },
    { customerIdx: 9, techIdx: null, status: "open", service: "TV Repair", area: "Oakland", cost: null, created_days_ago: 1, urgency: "tomorrow" },
    { customerIdx: 8, techIdx: null, status: "open", service: "Dryer Repair", area: "San Jose", cost: null, created_days_ago: 0, urgency: "today" },

    // Cancelled (4)
    { customerIdx: 2, techIdx: null, status: "cancelled", service: "AC Repair & Service", area: "Palo Alto", cost: null, created_days_ago: 9, urgency: "tomorrow" },
    { customerIdx: 6, techIdx: null, status: "cancelled", service: "Geyser Repair", area: "San Francisco", cost: null, created_days_ago: 13, urgency: "today" },
    { customerIdx: 11, techIdx: 3, status: "cancelled", service: "Refrigerator Repair", area: "Palo Alto", cost: 60, created_days_ago: 17, urgency: "urgent" },
    { customerIdx: 1, techIdx: 5, status: "cancelled", service: "Washing Machine Repair", area: "Oakland", cost: null, created_days_ago: 19, urgency: "tomorrow" },
  ],

  // ── WhatsApp Conversations (25) ──────────────────────────────────────────
  conversations: [
    { customerIdx: 0, messages: [
      { role: "customer", text: "Hi, my AC is not cooling properly. It's blowing warm air." },
      { role: "bot", text: "I'm sorry to hear that! I can help you get that sorted. May I know your location and preferred service time?" },
      { role: "customer", text: "I'm in San Francisco, Mission District. Can someone come today?" },
      { role: "bot", text: "Great! Let me check availability. We have a slot at 2-4 PM today. Would that work for you?" },
      { role: "customer", text: "Yes, that works. Please send someone." },
      { role: "bot", text: "Perfect! Your booking is confirmed. Technician Mike Johnson will arrive between 2-4 PM. Booking ref: #BK-001. Thank you!" },
    ]},
    { customerIdx: 1, messages: [
      { role: "customer", text: "My washing machine stopped spinning. It makes a loud noise." },
      { role: "bot", text: "That sounds like it could be a worn-out belt or motor issue. I can help with that. May I know your location and preferred service time?" },
      { role: "customer", text: "Oakland, near Lake Merritt. Tomorrow morning would be great." },
      { role: "bot", text: "We have a slot at 9-11 AM tomorrow. Our technician Sarah Chen specializes in washing machine repairs. Shall I confirm?" },
      { role: "customer", text: "Yes please, confirm it." },
    ]},
    { customerIdx: 2, messages: [
      { role: "customer", text: "My TV screen has vertical lines. It's a Samsung 55 inch." },
      { role: "bot", text: "Vertical lines on a Samsung screen could indicate a panel or T-con board issue. I can arrange a technician to diagnose it. What's your area?" },
      { role: "customer", text: "Palo Alto, downtown." },
      { role: "bot", text: "Our TV specialist David Martinez can visit tomorrow between 10 AM and 12 PM. Would that work?" },
      { role: "customer", text: "Yes, that works. Thanks!" },
    ]},
    { customerIdx: 3, messages: [
      { role: "customer", text: "No hot water from my geyser. It's been 2 days." },
      { role: "bot", text: "Oh no! No hot water is urgent. Let me help. What area are you in, and when would you like a technician?" },
      { role: "customer", text: "San Francisco, Sunset district. As soon as possible." },
      { role: "bot", text: "I can send Emily Wilson within the next 2 hours. She's our geyser specialist. Shall I confirm?" },
      { role: "customer", text: "Yes, send her please!" },
    ]},
    { customerIdx: 4, messages: [
      { role: "customer", text: "My refrigerator is not cooling. The freezer works fine though." },
      { role: "bot", text: "That usually points to an evaporator fan or damper issue. Let me help you book a service. What's your location?" },
      { role: "customer", text: "San Jose, downtown." },
      { role: "bot", text: "Noted! Our technician James Brown can visit tomorrow. Available slots are 9-11 AM or 2-4 PM. Which works best?" },
      { role: "customer", text: "2-4 PM works. Thank you!" },
    ]},
    { customerIdx: 5, messages: [
      { role: "customer", text: "Got a leak under my kitchen sink. Water everywhere!" },
      { role: "bot", text: "Oh dear! A water leak can cause damage fast. Let me get someone out to you urgently. What's your location?" },
      { role: "customer", text: "Oakland, near the airport." },
      { role: "bot", text: "Our technician Lisa Anderson is available now and can be there within 1 hour. She's excellent with plumbing issues. Shall I dispatch her?" },
      { role: "customer", text: "Yes, please hurry!" },
    ]},
    { customerIdx: 6, messages: [
      { role: "customer", text: "My microwave stopped heating food. The turntable works but food stays cold." },
      { role: "bot", text: "That sounds like a magnetron or high-voltage diode issue. Let me help you book a service. Where are you located?" },
      { role: "customer", text: "San Francisco, Marina district." },
      { role: "bot", text: "Our technician Robert Taylor can visit today at 4-6 PM. He's experienced with microwave repairs. Shall I confirm?" },
      { role: "customer", text: "Yes, 4-6 PM works. Thanks!" },
    ]},
    { customerIdx: 7, messages: [
      { role: "customer", text: "Hi, our AC unit is leaking water indoors. The whole floor is wet." },
      { role: "bot", text: "A leaking AC usually means a clogged drain line or frozen coil. This needs immediate attention. What's your location?" },
      { role: "customer", text: "Palo Alto, Stanford area." },
      { role: "bot", text: "I can send Mike Johnson right away. He'll be there within 1.5 hours. Shall I dispatch him?" },
      { role: "customer", text: "Yes, please do!" },
    ]},
    { customerIdx: 8, messages: [
      { role: "customer", text: "My dryer isn't drying clothes. It runs but stays cold." },
      { role: "bot", text: "That sounds like a heating element issue. Let me help. What area are you in?" },
      { role: "customer", text: "San Jose, Campbell area." },
      { role: "bot", text: "Sarah Chen specializes in dryer repairs. She can come tomorrow between 10 AM and 12 PM. Does that work?" },
      { role: "customer", text: "Yes, that sounds good. Confirm it." },
    ]},
    { customerIdx: 9, messages: [
      { role: "customer", text: "Need a new AC installation for my office. 2 ton split unit." },
      { role: "bot", text: "Great! We offer AC installation services. Let me help you with the details. What's your location and preferred installation date?" },
      { role: "customer", text: "Oakland, near downtown. This weekend would be ideal." },
      { role: "bot", text: "We can do Saturday morning. Our technician Mike Johnson leads installations. Shall I schedule it for 9 AM Saturday?" },
      { role: "customer", text: "Perfect. See you Saturday!" },
    ]},
    { customerIdx: 10, messages: [
      { role: "customer", text: "The ice maker in my fridge stopped working. Any ideas?" },
      { role: "bot", text: "Ice maker issues are common and often fixable. What's your location and when would you like a technician?" },
      { role: "customer", text: "San Francisco, Nob Hill. Tomorrow afternoon." },
      { role: "bot", text: "Our technician Robert Taylor can visit tomorrow between 2-4 PM. He's repaired many ice makers. Shall I book it?" },
      { role: "customer", text: "Yes, go ahead!" },
    ]},
    { customerIdx: 11, messages: [
      { role: "customer", text: "My OLED TV has a dead pixel line. It's under warranty but I need a service center." },
      { role: "bot", text: "I understand. While we aren't an authorized service center, our TV specialist David Martinez can diagnose the issue first. Where are you located?" },
      { role: "customer", text: "Palo Alto." },
      { role: "bot", text: "David can visit tomorrow 10-12 or 2-4 PM. Which slot works best for a diagnostic visit?" },
      { role: "customer", text: "10 AM works. Thank you." },
    ]},
    { customerIdx: 5, messages: [
      { role: "customer", text: "My dishwasher won't drain. Leaving standing water at the bottom." },
      { role: "bot", text: "Standing water usually means a clogged drain pump or filter. Let me help. What's your area?" },
      { role: "customer", text: "Oakland. Can someone come today?" },
      { role: "bot", text: "Lisa Anderson specializes in dishwasher repairs and can visit today at 4-6 PM. Shall I schedule?" },
      { role: "customer", text: "Yes, please. Thanks!" },
    ]},
    { customerIdx: 3, messages: [
      { role: "customer", text: "My washing machine shakes violently during spin cycle." },
      { role: "bot", text: "A shaking washer usually means unbalanced load or worn suspension springs. Let me help. Where are you located?" },
      { role: "customer", text: "San Francisco." },
      { role: "bot", text: "Sarah Chen can come tomorrow morning. She's excellent with washer issues. 9-11 AM work?" },
      { role: "customer", text: "Yes, 9 AM works!" },
    ]},
    { customerIdx: 0, messages: [
      { role: "customer", text: "Follow up on my AC repair last week. It's cooling better now, thanks!" },
      { role: "bot", text: "We're glad to hear that! Your repair has a 30-day warranty, so if you face any issues, just let us know. Would you like to leave a review?" },
      { role: "customer", text: "Sure! 5 stars. Great service." },
      { role: "bot", text: "Thank you so much! We appreciate your feedback. Feel free to reach out anytime for any appliance needs." },
    ]},
    { customerIdx: 2, messages: [
      { role: "customer", text: "My TV is working now after the repair. Thanks for the quick service!" },
      { role: "bot", text: "That's wonderful to hear! David takes great pride in his work. Remember, you have a 30-day warranty on parts and labor. Anything else we can help with?" },
      { role: "customer", text: "No, that's all. Thanks again!" },
    ]},
    { customerIdx: 1, messages: [
      { role: "customer", text: "Hi, I want to reschedule my washing machine repair." },
      { role: "bot", text: "No problem! Your current slot is tomorrow 9-11 AM. What new time works better for you?" },
      { role: "customer", text: "Can we do 2-4 PM instead?" },
      { role: "bot", text: "I've checked and 2-4 PM is available. Let me update your booking. Your technician Sarah Chen will now arrive between 2-4 PM tomorrow." },
      { role: "customer", text: "Thanks for the help!" },
    ]},
    { customerIdx: 7, messages: [
      { role: "customer", text: "The AC you fixed last week is leaking again. Still under warranty right?" },
      { role: "bot", text: "Yes, absolutely! All our repairs come with a 30-day warranty. Let me schedule a follow-up visit. Mike Johnson can come today at 4-6 PM to check it. Does that work?" },
      { role: "customer", text: "Yes, that works. Please send him." },
      { role: "bot", text: "Booking confirmed! Mike will be there between 4-6 PM today. There's no charge for warranty service. Thank you for your patience!" },
    ]},
    { customerIdx: 4, messages: [
      { role: "customer", text: "Do you service LG refrigerators?" },
      { role: "bot", text: "Yes! We service all major brands including LG, Samsung, Whirlpool, GE, Bosch, and more. What issue are you facing?" },
      { role: "customer", text: "The ice dispenser is jammed. Ice cubes are stuck." },
      { role: "bot", text: "A jammed ice dispenser is a common fix. I can get a technician out to you. What's your location and preferred time?" },
      { role: "customer", text: "San Jose. Tomorrow morning." },
      { role: "bot", text: "James Brown can come tomorrow 9-11 AM. He's familiar with LG refrigerators. Shall I book?" },
      { role: "customer", text: "Yes, book it!" },
    ]},
    { customerIdx: 9, messages: [
      { role: "customer", text: "Hi, my microwave is sparking inside. That's dangerous right?" },
      { role: "bot", text: "⚠️ Yes, sparking inside a microwave is a safety hazard! Please unplug it immediately and do not use it. Let me send a technician urgently. Where are you?" },
      { role: "customer", text: "Oakland. Please send someone ASAP!" },
      { role: "bot", text: "Our technician David Martinez specializes in microwave repairs. He can be at your location within 1 hour. Shall I dispatch him?" },
      { role: "customer", text: "Yes, please! Thank you." },
    ]},
    { customerIdx: 6, messages: [
      { role: "customer", text: "How much does an AC service cost?" },
      { role: "bot", text: "Our standard AC service starts at $79 for a basic check and clean. A full service including gas check is $149. Both include a 30-day warranty. Would you like to book?" },
      { role: "customer", text: "What's included in the basic service?" },
      { role: "bot", text: "The basic service includes: filter cleaning, coil inspection, drain line check, temperature check, and basic performance test. Would you like to schedule one?" },
      { role: "customer", text: "Yes, book me for a basic service. I'm in San Francisco." },
      { role: "bot", text: "Great! Mike Johnson can come tomorrow at 10 AM. Shall I confirm?" },
      { role: "customer", text: "Yes, confirm!" },
    ]},
    { customerIdx: 11, messages: [
      { role: "customer", text: "Hey, my refrigerator is making weird clicking noises." },
      { role: "bot", text: "Clicking noises from a fridge could be the compressor relay or condenser fan. Let me help. Where are you located?" },
      { role: "customer", text: "Palo Alto." },
      { role: "bot", text: "James Brown can investigate the noise tomorrow between 10 AM and 12 PM. He's experienced with refrigerator issues. Want me to book it?" },
      { role: "customer", text: "Yes please, book it." },
    ]},
    { customerIdx: 10, messages: [
      { role: "customer", text: "Can you install a new dishwasher? I want to replace my old one." },
      { role: "bot", text: "Yes, we offer dishwasher installation services! We'll remove your old unit, install the new one, and ensure everything works. What area are you in?" },
      { role: "customer", text: "San Francisco, Castro district." },
      { role: "bot", text: "Lisa Anderson specializes in dishwasher installations. She can come Saturday between 9 AM and 12 PM. Installation costs $99 plus any parts. Shall I book?" },
      { role: "customer", text: "Sounds good. Book Saturday morning!" },
    ]},
    { customerIdx: 8, messages: [
      { role: "customer", text: "Do you offer any discount for first-time customers?" },
      { role: "bot", text: "Yes! First-time customers get 10% off their first service. Just mention this offer when the technician arrives. Would you like to book your first service?" },
      { role: "customer", text: "Great! My AC needs servicing. San Jose." },
      { role: "bot", text: "Excellent! I can schedule a basic AC service for you. Mike Johnson can come tomorrow at 10 AM or 2 PM. Which works?" },
      { role: "customer", text: "10 AM works. Thanks for the discount!" },
    ]},
    { customerIdx: 5, messages: [
      { role: "customer", text: "My refrigerator door isn't sealing properly. Frost building up." },
      { role: "bot", text: "A bad door seal (gasket) can cause frost buildup and higher electricity bills. Let me help. What's your location?" },
      { role: "customer", text: "Oakland, near Lake Merritt." },
      { role: "bot", text: "James Brown is nearby and can check it today at 2 PM. He can replace the gasket if needed. Parts average $25-40. Shall I book?" },
      { role: "customer", text: "Yes, check it out please." },
    ]},
  ],
};

// ── Helper: build a timestamp relative to now ────────────────────────────────
function ago(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(9 + Math.floor(Math.random() * 10)); // random hour between 9am-7pm
  d.setMinutes(Math.floor(Math.random() * 60));
  return d.toISOString();
}

// ── Helper: generate realistic revenue chart data (last 30 days) ────────────
function generateRevenueChart() {
  const chart = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    // Weekdays: 0-5 jobs, Weekends: 0-2 jobs
    const jobCount = isWeekend ? Math.floor(Math.random() * 3) : Math.floor(Math.random() * 6);
    const revenue = jobCount * (120 + Math.floor(Math.random() * 200));
    chart.push({ date: dateStr, revenue, bookings: jobCount });
  }
  return chart;
}

// ── Export all demo data ────────────────────────────────────────────────────
module.exports = {
  DEMO,
  ago,
  generateRevenueChart,
};
