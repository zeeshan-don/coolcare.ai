// api/_lib/demo-data.js
// Realistic demo data generator for CoolCare AI Demo Mode.
// All data is fabricated — no real customers, shops, or personal info is used.
// Generates Bengaluru-based Indian market data procedurally.
// Every demo session gets fresh, realistic data that makes the product
// feel like it has been used by a real business for months.

// ═════════════════════════════════════════════════════════════════════════════
// DATA POOLS
// ═════════════════════════════════════════════════════════════════════════════

const INDIAN_FIRST_NAMES = [
  "Aarav","Aarush","Abhay","Abhishek","Aditya","Ajay","Akhil","Amit","Anand","Aniket",
  "Anil","Anirudh","Arjun","Arun","Ashish","Ashok","Ashwin","Ayush","Balaji","Bharat",
  "Chetan","Chirag","Darshan","Deepak","Dhruv","Dinesh","Gaurav","Girish","Gopal","Hari",
  "Harish","Harsh","Hemant","Hitesh","Ishan","Ishaan","Jagdish","Jatin","Jayesh","Karan",
  "Karthik","Kiran","Kishore","Kumar","Lalit","Lokesh","Madhav","Manish","Manohar","Mohan",
  "Mukesh","Nagesh","Nandan","Naresh","Naveen","Neeraj","Nikhil","Nitin","Om","Pankaj",
  "Parag","Paresh","Pavan","Pradeep","Prakash","Prashant","Pratik","Praveen","Prem","Rahul",
  "Raj","Rajat","Rajesh","Rakesh","Ram","Ramesh","Ranbir","Ravi","Rohit","Rohan",
  "Sachin","Sagar","Sameer","Sandeep","Sanjay","Santosh","Satyam","Shashank","Shekhar","Shiv",
  "Shridhar","Shubham","Siddharth","Soham","Sudhir","Sukumar","Sunil","Suresh","Swapnil","Tanmay",
  "Tarun","Uday","Umesh","Utkarsh","Varun","Venkatesh","Vijay","Vikas","Vinay","Vinod",
  "Vishal","Vivek","Yash","Yogesh"
];

const FEMALE_FIRST_NAMES = [
  "Aanya","Aditi","Aishwarya","Amita","Ananya","Anjali","Ankita","Anushka","Archana","Arpita",
  "Asha","Bhavana","Bhavya","Chaitra","Deepa","Deepika","Devi","Divya","Durga","Esha",
  "Gayatri","Geeta","Gowri","Harini","Hema","Isha","Janaki","Jayanti","Jyoti","Kajal",
  "Kalpana","Kamala","Kavita","Kriti","Lakshmi","Lalita","Lata","Madhuri","Mala","Mamta",
  "Manisha","Manju","Meena","Megha","Mitali","Mohini","Nandini","Neelam","Neha","Nidhi",
  "Nikita","Nirmala","Pallavi","Parvati","Phool","Pooja","Poonam","Prachi","Pragya","Priti",
  "Purnima","Rachna","Radhika","Rajni","Raksha","Rani","Reema","Rekha","Renu","Rohini",
  "Rupali","Sandhya","Sangeeta","Saraswati","Seema","Shalini","Shanti","Shikha","Shreya","Shweta",
  "Sneha","Sonia","Sonali","Sridevi","Sujata","Sumitra","Sunita","Supriya","Sushma","Swati",
  "Tanya","Trisha","Uma","Usha","Vaishali","Vandana","Varsha","Vidya","Vimala","Yamini"
];

const LAST_NAMES = [
  "Acharya","Agrawal","Arora","Bajaj","Bhat","Bhatt","Chopra","Das","Desai","Deshmukh",
  "Deshpande","Dubey","Gaikwad","Gandhi","Ghosh","Gupta","Hegde","Iyer","Jadhav","Jain",
  "Jha","Joshi","Kadam","Kamath","Kapoor","Kaur","Khan","Kohli","Kulkarni","Kumar",
  "Mahajan","Malhotra","Mehta","Menon","Mishra","Mittal","Modi","More","Mukherjee","Naidu",
  "Naik","Nair","Nayak","Padmanabhan","Pal","Pandey","Pandit","Parekh","Parikh","Patel",
  "Patil","Patkar","Pillai","Prasad","Purohit","Raghavan","Raj","Rajput","Ramachandran","Raman",
  "Rana","Rane","Rao","Rathore","Reddy","Roy","Sachdev","Sahni","Saxena","Sen",
  "Shah","Sharma","Shetty","Shukla","Singh","Sinha","Soni","Srinivasan","Subramaniam","Tandon",
  "Tiwari","Trivedi","Varma","Venkatesh","Verma","Wagh","Waghle","Yadav"
];

const BENGALURU_AREAS = [
  "Indiranagar","Koramangala","Whitefield","JP Nagar","Jayanagar","BT Layout","HSR Layout",
  "Electronic City","Marathahalli","Banashankari","Basavanagudi","Malleshwaram","Rajajinagar",
  "RT Nagar","Yelahanka","Hebbal","Sadashivanagar","Vasanth Nagar","Ulsoor","Domlur",
  "Bellandur","Sarjapur Road","Kanakapura Road","Magadi Road","Tumkur Road","Old Airport Road",
  "MG Road","Brigade Road","Commercial Street","Residency Road","Lavelle Road","Cunningham Road",
  "Richmond Town","Shivaji Nagar","Kengeri","Vijayanagar","Bidadi","Devanahalli","Nelamangala",
  "Anekal","Hosur Road","Mysore Road","NICE Road","Bannerghatta Road","Kanakapura","Kengeri"
];

const SERVICES = [
  { name: "AC Repair & Service", minCost: 500, maxCost: 2500, category: "AC" },
  { name: "AC Gas Refill", minCost: 1200, maxCost: 3500, category: "AC" },
  { name: "AC Installation", minCost: 2000, maxCost: 5000, category: "AC" },
  { name: "AC Not Cooling", minCost: 600, maxCost: 2000, category: "AC" },
  { name: "AC Water Leakage", minCost: 400, maxCost: 1500, category: "AC" },
  { name: "Washing Machine Repair", minCost: 500, maxCost: 2000, category: "WM" },
  { name: "Washing Machine Not Spinning", minCost: 600, maxCost: 1800, category: "WM" },
  { name: "Washing Machine Water Leak", minCost: 400, maxCost: 1500, category: "WM" },
  { name: "Washing Machine Installation", minCost: 500, maxCost: 1200, category: "WM" },
  { name: "Refrigerator Repair", minCost: 600, maxCost: 3000, category: "RF" },
  { name: "Refrigerator Not Cooling", minCost: 800, maxCost: 3000, category: "RF" },
  { name: "Refrigerator Gas Refill", minCost: 1500, maxCost: 4000, category: "RF" },
  { name: "Refrigerator Ice Maker Issue", minCost: 500, maxCost: 2000, category: "RF" },
  { name: "Refrigerator Water Dispenser", minCost: 600, maxCost: 2000, category: "RF" },
  { name: "Microwave Repair", minCost: 400, maxCost: 1500, category: "MW" },
  { name: "Microwave Not Heating", minCost: 500, maxCost: 1500, category: "MW" },
  { name: "RO Purifier Service", minCost: 500, maxCost: 2000, category: "RO" },
  { name: "RO Purifier Installation", minCost: 400, maxCost: 1000, category: "RO" },
  { name: "RO Membrane Change", minCost: 800, maxCost: 2500, category: "RO" },
  { name: "Geyser Repair", minCost: 400, maxCost: 1500, category: "GE" },
  { name: "Geyser Not Heating", minCost: 500, maxCost: 1500, category: "GE" },
  { name: "Geyser Installation", minCost: 600, maxCost: 1500, category: "GE" },
  { name: "TV Repair", minCost: 800, maxCost: 3000, category: "TV" },
  { name: "TV Screen Issue", minCost: 1000, maxCost: 3500, category: "TV" },
  { name: "Dishwasher Repair", minCost: 600, maxCost: 2000, category: "DW" },
  { name: "Chimney Repair", minCost: 500, maxCost: 1800, category: "CH" },
  { name: "Water Purifier Repair", minCost: 400, maxCost: 1500, category: "RO" },
  { name: "Inverter Repair", minCost: 600, maxCost: 2000, category: "IN" },
  { name: "Mixer Grinder Repair", minCost: 300, maxCost: 800, category: "MG" },
];

const URGENCIES = ["urgent", "today", "tomorrow", "this week", "next week"];
const PRIORITIES = ["low", "normal", "high", "urgent"];

const SPECIALIZATIONS = {
  AC: ["AC Repair", "AC Service", "AC Installation", "HVAC", "Gas Refill"],
  WM: ["Washing Machine Repair", "Dryer Repair", "Dishwasher Repair"],
  RF: ["Refrigerator Repair", "Ice Maker Repair", "Cooling Systems"],
  MW: ["Microwave Repair", "Oven Repair", "Small Appliances"],
  RO: ["RO Purifier", "Water Purifier", "Plumbing"],
  GE: ["Geyser Repair", "Water Heater", "Plumbing"],
  TV: ["TV Repair", "Electronics", "Display Repair"],
  DW: ["Dishwasher Repair", "Chimney Repair", "Kitchen Appliances"],
};

// Issue descriptions for conversations
const ISSUE_TEMPLATES = {
  AC: [
    "My AC is not cooling properly. It's blowing warm air.",
    "The AC is leaking water indoors. The whole floor is wet.",
    "My AC makes a loud noise when running.",
    "The AC turns off by itself after 10 minutes.",
    "AC remote is not working. Need to get it checked.",
    "The AC filter needs cleaning. It's been 6 months.",
    "My split AC has a gas leak. Coolant is leaking out.",
    "AC installation needed for my new apartment living room.",
    "The AC outdoor unit is making grinding sounds.",
    "My inverter AC is showing error code E1 on display.",
  ],
  WM: [
    "My washing machine stopped spinning. Makes loud noise.",
    "Washing machine is leaking water from the bottom.",
    "The machine shakes violently during spin cycle.",
    "Water is not draining from the washing machine.",
    "My front load washer door is stuck, won't open.",
    "Washing machine showing error code 4E. Water not filling.",
    "The drum is not rotating in my washing machine.",
    "Need washing machine installation for new LG 7kg.",
  ],
  RF: [
    "Refrigerator is not cooling. Freezer works fine.",
    "My fridge is making weird clicking noises.",
    "The ice maker in my fridge stopped working.",
    "Refrigerator door is not sealing properly. Frost building up.",
    "Water dispenser is not working on my fridge.",
    "The refrigerator is cooling too much. Everything is freezing.",
    "There's a strange smell coming from my refrigerator.",
    "My Samsung fridge compressor is very hot to touch.",
  ],
  MW: [
    "My microwave stopped heating food. Turntable works but food stays cold.",
    "Microwave is sparking inside when running. That's dangerous right?",
    "The microwave display is not working but it runs.",
    "My microwave makes a buzzing sound and then stops.",
    "The turntable in my microwave is not rotating.",
    "Microwave door is not closing properly. Safety issue.",
  ],
  RO: [
    "My RO water purifier is not working. No water coming out.",
    "RO purifier is leaking water from the filter area.",
    "The water taste has changed. Needs maintenance.",
    "RO purifier display showing red light. Filter change needed?",
    "My water purifier is making gurgling sounds.",
    "The RO storage tank is not filling up.",
  ],
  GE: [
    "No hot water from my geyser. It's been 2 days.",
    "Geyser is leaking water from the safety valve.",
    "My geyser makes a loud popping sound when heating.",
    "The water from geyser is not hot enough. Lukewarm at best.",
    "Geyser trips the circuit breaker every time I turn it on.",
    "Need new geyser installation. Old one stopped working.",
  ],
  TV: [
    "My TV screen has vertical lines. Samsung 55 inch.",
    "TV is not turning on. Power light blinks but no display.",
    "The TV has sound but no picture. Screen is black.",
    "My smart TV is very slow and keeps freezing.",
    "There's a crack on my TV screen. Need to check if repairable.",
    "TV remote not working. Need a replacement or repair.",
  ],
};

const APPLIANCE_TYPES = ["AC", "Washing Machine", "Refrigerator", "Microwave", "RO Purifier", "Geyser", "TV", "Dishwasher", "Chimney"];

// ═════════════════════════════════════════════════════════════════════════════
// GENERATOR FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min, max, decimals = 2) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function generateIndianPhone() {
  const prefixes = ["91", "90", "99", "98", "97", "96", "89", "88", "87", "86", "85", "84", "83", "82", "81", "80", "79", "78", "77", "76", "75", "74", "73", "72", "71", "70", "63", "62", "61", "60"];
  const prefix = pick(prefixes);
  const suffix = String(randInt(100000, 999999));
  return "+91" + prefix + suffix;
}

function generateCustomerName() {
  const first = Math.random() > 0.45 ? pick(INDIAN_FIRST_NAMES) : pick(FEMALE_FIRST_NAMES);
  const last = pick(LAST_NAMES);
  return first + " " + last;
}

function generateCustomerAddress(area) {
  const streetTypes = ["Main Road", "Cross Road", "1st Main", "2nd Main", "3rd Cross", "4th Cross", "5th Main", "1st Stage", "2nd Stage", "Layout", "Extension", "Sector"];
  const buildings = ["Apt", "Tower", "Block", "Nagar", "Nilaya", "Enclave", "Residency", "Mansion", "Villa", "Court"];
  const num = randInt(1, 999);
  const street = randInt(1, 20) + " " + pick(streetTypes);
  const building = pick(buildings);
  return num + ", " + street + ", " + area + ", " + pick(building) + ", Bengaluru";
}

// ─── Generator: Customers (100) ────────────────────────────────────────────
function generateCustomers(count) {
  const customers = [];
  const usedPhones = new Set();

  for (let i = 0; i < count; i++) {
    let phone;
    do { phone = generateIndianPhone(); } while (usedPhones.has(phone));
    usedPhones.add(phone);

    const name = generateCustomerName();
    const area = pick(BENGALURU_AREAS);
    const address = generateCustomerAddress(area);
    const totalVisits = randInt(1, 8);
    const totalSpent = totalVisits * randInt(500, 2000);

    customers.push({
      name,
      phone,
      city: "Bengaluru",
      area,
      address,
      total_visits: totalVisits,
      total_spent: totalSpent,
    });
  }

  return customers;
}

// ─── Generator: Technicians (8) ────────────────────────────────────────────
function generateTechnicians() {
  return [
    {
      name: "Rajesh Kumar",
      phone: "+919876543201",
      email: "rajesh@coolcare.demo",
      specialization: ["AC Repair", "AC Installation", "Gas Refill", "Refrigerator Repair", "HVAC"],
      active: true,
      rating: 4.8,
      jobs_completed: 287,
      area: "Indiranagar",
    },
    {
      name: "Suresh Patel",
      phone: "+919876543202",
      email: "suresh@coolcare.demo",
      specialization: ["Washing Machine Repair", "Dishwasher Repair", "Dryer Repair", "Kitchen Appliances"],
      active: true,
      rating: 4.9,
      jobs_completed: 342,
      area: "Koramangala",
    },
    {
      name: "Amit Singh",
      phone: "+919876543203",
      email: "amit@coolcare.demo",
      specialization: ["TV Repair", "Microwave Repair", "Electronics", "Display Repair"],
      active: true,
      rating: 4.7,
      jobs_completed: 198,
      area: "Whitefield",
    },
    {
      name: "Vijay Sharma",
      phone: "+919876543204",
      email: "vijay@coolcare.demo",
      specialization: ["RO Purifier", "Geyser Repair", "Water Heater", "Plumbing"],
      active: true,
      rating: 4.6,
      jobs_completed: 156,
      area: "JP Nagar",
    },
    {
      name: "Deepa Iyer",
      phone: "+919876543205",
      email: "deepa@coolcare.demo",
      specialization: ["AC Repair", "Refrigerator Repair", "General Appliance", "AC Service"],
      active: true,
      rating: 4.9,
      jobs_completed: 223,
      area: "Jayanagar",
    },
    {
      name: "Prakash Rao",
      phone: "+919876543206",
      email: "prakash@coolcare.demo",
      specialization: ["Washing Machine Repair", "Refrigerator Repair", "Microwave Repair", "General Appliance"],
      active: true,
      rating: 4.5,
      jobs_completed: 178,
      area: "HSR Layout",
    },
    {
      name: "Manjunath Hegde",
      phone: "+919876543207",
      email: "manjunath@coolcare.demo",
      specialization: ["AC Installation", "Geyser Installation", "Chimney Repair", "RO Purifier"],
      active: true,
      rating: 4.4,
      jobs_completed: 134,
      area: "Malleshwaram",
    },
    {
      name: "Kavita Nair",
      phone: "+919876543208",
      email: "kavita@coolcare.demo",
      specialization: ["TV Repair", "Electronics", "Microwave Repair", "Smart Home"],
      active: true,
      rating: 4.7,
      jobs_completed: 165,
      area: "Electronic City",
    },
  ];
}

// ─── Generator: Bookings (200+) ───────────────────────────────────────────
function generateBookings(customers, techCount) {
  const bookings = [];

  // --- Helper to create a single booking ---
  function addBooking(customerIdx, techIdx, status, serviceName, area, daysAgo, urgency, finalCost) {
    const service = SERVICES.find(s => s.name === serviceName) || SERVICES[0];
    const priority = urgency === "urgent" ? "urgent" : urgency === "today" ? "high" : urgency === "tomorrow" ? "normal" : "normal";
    const estCost = finalCost || (status === "completed" ? randInt(service.minCost, service.maxCost) : null);

    bookings.push({
      customerIdx,
      techIdx,
      status,
      service: serviceName,
      area,
      cost: estCost,
      final_cost: finalCost || null,
      created_days_ago: daysAgo,
      urgency: urgency || "normal",
      priority,
    });
  }

  // ---- COMPLETED BOOKINGS (120) - spread across 365 days ----
  // These provide revenue history across 12 months with a growth trend
  let completedId = 0;
  for (let monthOffset = 12; monthOffset >= 1; monthOffset--) {
    // More bookings in recent months (growth trend)
    const baseCount = monthOffset <= 1 ? 18 : Math.max(3, Math.floor(18 - (12 - monthOffset) * 1.2));
    const count = baseCount + randInt(-2, 3);

    for (let i = 0; i < count && completedId < 120; i++) {
      const customerIdx = randInt(0, customers.length - 1);
      const techIdx = randInt(0, techCount - 1);
      const service = pick(SERVICES);
      const area = pick(BENGALURU_AREAS);
      const daysInMonth = monthOffset * 30 - randInt(0, 28);
      const finalCost = randInt(service.minCost, service.maxCost);
      const urgency = pick(URGENCIES);

      const cust = customers[customerIdx];
      // Update customer stats
      cust.total_visits = (cust.total_visits || 0) + 1;
      cust.total_spent = (cust.total_spent || 0) + finalCost;

      bookings.push({
        customerIdx,
        techIdx,
        status: "completed",
        service: service.name,
        area,
        cost: finalCost,
        final_cost: finalCost,
        created_days_ago: daysInMonth,
        completed_days_ago: Math.max(0, daysInMonth - randInt(0, 2)),
        urgency,
        priority: "normal",
      });
      completedId++;
    }
  }

  // ---- CANCELLED BOOKINGS (30) - spread across last 90 days ----
  for (let i = 0; i < 30; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    const techIdx = Math.random() > 0.3 ? randInt(0, techCount - 1) : null;
    const service = pick(SERVICES);
    const area = pick(BENGALURU_AREAS);
    const daysAgo = randInt(1, 90);
    const hadVisit = Math.random() > 0.6; // some had partial cost for visit
    const finalCost = hadVisit ? randInt(100, service.minCost) : null;
    const urgency = pick(URGENCIES);

    bookings.push({
      customerIdx,
      techIdx,
      status: "cancelled",
      service: service.name,
      area,
      cost: finalCost,
      final_cost: null,
      created_days_ago: daysAgo,
      urgency,
      priority: "normal",
    });
  }

  // ---- OPEN BOOKINGS (18) - very recent ----
  for (let i = 0; i < 18; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    const service = pick(SERVICES);
    const area = pick(BENGALURU_AREAS);
    const daysAgo = randInt(0, 3);
    const urgency = pick(["urgent", "today", "tomorrow"]);

    bookings.push({
      customerIdx,
      techIdx: null,
      status: "open",
      service: service.name,
      area,
      cost: null,
      final_cost: null,
      created_days_ago: daysAgo,
      urgency,
      priority: urgency === "urgent" ? "urgent" : "high",
    });
  }

  // ---- ACCEPTED BOOKINGS (12) ----
  for (let i = 0; i < 12; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    const techIdx = Math.random() > 0.3 ? randInt(0, techCount - 1) : null;
    const service = pick(SERVICES);
    const area = pick(BENGALURU_AREAS);
    const daysAgo = randInt(0, 2);
    const urgency = pick(["urgent", "today"]);

    bookings.push({
      customerIdx,
      techIdx,
      status: "accepted",
      service: service.name,
      area,
      cost: null,
      final_cost: null,
      created_days_ago: daysAgo,
      urgency,
      priority: "high",
    });
  }

  // ---- ASSIGNED BOOKINGS (10) ----
  for (let i = 0; i < 10; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    const techIdx = randInt(0, techCount - 1);
    const service = pick(SERVICES);
    const area = pick(BENGALURU_AREAS);
    const daysAgo = randInt(0, 1);
    const urgency = pick(["urgent", "today"]);

    bookings.push({
      customerIdx,
      techIdx,
      status: "assigned",
      service: service.name,
      area,
      cost: null,
      final_cost: null,
      created_days_ago: daysAgo,
      urgency,
      priority: "high",
    });
  }

  // ---- ON_THE_WAY BOOKINGS (8) ----
  for (let i = 0; i < 8; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    const techIdx = randInt(0, techCount - 1);
    const service = pick(SERVICES);
    const area = pick(BENGALURU_AREAS);
    const urgency = "urgent";

    bookings.push({
      customerIdx,
      techIdx,
      status: "on_the_way",
      service: service.name,
      area,
      cost: null,
      final_cost: null,
      created_days_ago: 0,
      urgency,
      priority: "urgent",
    });
  }

  // ---- ARRIVED BOOKINGS (6) ----
  for (let i = 0; i < 6; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    const techIdx = randInt(0, techCount - 1);
    const service = pick(SERVICES);
    const area = pick(BENGALURU_AREAS);
    const urgency = "urgent";

    bookings.push({
      customerIdx,
      techIdx,
      status: "arrived",
      service: service.name,
      area,
      cost: null,
      final_cost: null,
      created_days_ago: 0,
      urgency,
      priority: "urgent",
    });
  }

  // Sort by created_days_ago descending (most recent first)
  bookings.sort((a, b) => a.created_days_ago - b.created_days_ago);

  return bookings;
}

// ─── Generator: WhatsApp Conversations (35) ────────────────────────────────
function generateConversations(customers) {
  const conversations = [];

  // Conversation scenarios by appliance type
  function createACConversation(customerIdx, scenarioIdx) {
    const issues = [
      "My AC is not cooling properly. It's blowing warm air.",
      "The AC is leaking water indoors. The whole floor is wet.",
      "My AC makes a loud noise when running. It's disturbing the neighbors.",
    ];
    const issue = issues[scenarioIdx % issues.length];

    return {
      customerIdx,
      messages: [
        { role: "customer", text: issue },
        { role: "bot", text: "I'm sorry to hear that! I can help you get that sorted. May I know your location and preferred service time?" },
        { role: "customer", text: "I'm in " + pick(BENGALURU_AREAS) + ". Can someone come today?" },
        { role: "bot", text: "Great! Let me check availability. We have a slot at 2-4 PM today. Our AC specialist can visit during that time. Would that work for you?" },
        { role: "customer", text: "Yes, that works. Please send someone." },
        { role: "bot", text: "Perfect! Your booking is confirmed. Our technician will arrive between 2-4 PM today. You'll receive an update when they're on the way. Thank you! 🙏" },
      ],
    };
  }

  function createWMConversation(customerIdx, scenarioIdx) {
    const issues = [
      "My washing machine stopped spinning. It makes a loud noise during the cycle.",
      "The washing machine is leaking water from the bottom. Floor is all wet.",
      "My front load washer door is stuck and won't open. Clothes are trapped inside!",
    ];
    const issue = issues[scenarioIdx % issues.length];

    return {
      customerIdx,
      messages: [
        { role: "customer", text: issue },
        { role: "bot", text: "That sounds like it needs immediate attention. I can help you book a service. May I know your location and preferred time?" },
        { role: "customer", text: pick(BENGALURU_AREAS) + ". Tomorrow morning would be great." },
        { role: "bot", text: "We have a slot at 9-11 AM tomorrow. Our washing machine expert can visit during that time. Shall I confirm?" },
        { role: "customer", text: "Yes please, confirm it. Thanks!" },
      ],
    };
  }

  function createRFConversation(customerIdx, scenarioIdx) {
    const issues = [
      "My refrigerator is not cooling properly. The freezer works fine though.",
      "My fridge is making weird clicking noises. Worried it might break down.",
      "The ice maker in my refrigerator stopped working. No ice for days!",
    ];
    const issue = issues[scenarioIdx % issues.length];

    return {
      customerIdx,
      messages: [
        { role: "customer", text: issue },
        { role: "bot", text: "I understand your concern. Let me help you book a service. What's your location and when would you like a technician to visit?" },
        { role: "customer", text: pick(BENGALURU_AREAS) + ". Can someone come tomorrow afternoon?" },
        { role: "bot", text: "Noted! Our refrigeration specialist can visit tomorrow between 2-4 PM. We service all brands including Samsung, LG, Whirlpool, and Godrej. Shall I book it?" },
        { role: "customer", text: "Yes, 2-4 PM works. Thank you!" },
      ],
    };
  }

  function createMWConversation(customerIdx, scenarioIdx) {
    const issues = [
      "My microwave stopped heating food. The turntable works but food stays cold.",
      "Microwave is sparking inside when I run it. That's dangerous right?",
      "My microwave display is not working but it seems to run.",
    ];
    const issue = issues[scenarioIdx % issues.length];

    return {
      customerIdx,
      messages: [
        { role: "customer", text: issue },
        { role: "bot", text: "That sounds like it needs professional attention. For safety, please stop using it until a technician checks it. Let me help book a service. Where are you located?" },
        { role: "customer", text: pick(BENGALURU_AREAS) + ". Can someone come today?" },
        { role: "bot", text: "Our microwave repair specialist is available today at 4-6 PM. They can visit your location. Shall I confirm the appointment?" },
        { role: "customer", text: "Yes, please. Thanks for the quick response!" },
      ],
    };
  }

  function createROConversation(customerIdx, scenarioIdx) {
    const issues = [
      "My RO water purifier is not working. No water is coming out.",
      "The RO purifier is leaking water from the side. Pooling on the counter.",
      "Water from my purifier tastes funny. I think it needs servicing.",
    ];
    const issue = issues[scenarioIdx % issues.length];

    return {
      customerIdx,
      messages: [
        { role: "customer", text: issue },
        { role: "bot", text: "I can help you with that! RO purifier issues are common and usually fixable. Where are you located and when would you like a technician?" },
        { role: "customer", text: pick(BENGALURU_AREAS) + ". As soon as possible please. We need drinking water." },
        { role: "bot", text: "Our RO specialist can visit today between 2-4 PM. We carry common spare parts like membranes and filters. Shall I schedule it?" },
        { role: "customer", text: "Yes please, send someone today." },
      ],
    };
  }

  function createGEConversation(customerIdx, scenarioIdx) {
    const issues = [
      "No hot water from my geyser. It's been 2 days and it's cold in the mornings!",
      "My geyser is leaking water from the bottom. Need it fixed urgently.",
      "The geyser trips the circuit breaker every time I switch it on.",
    ];
    const issue = issues[scenarioIdx % issues.length];

    return {
      customerIdx,
      messages: [
        { role: "customer", text: issue },
        { role: "bot", text: "Oh no! No hot water is definitely urgent, especially in this weather. Let me help you get it fixed quickly. What area are you in?" },
        { role: "customer", text: pick(BENGALURU_AREAS) + ". Please send someone ASAP!" },
        { role: "bot", text: "Our geyser specialist can be at your place within 2 hours. They handle all brands like Racold, AO Smith, Bajaj, and Havells. Shall I dispatch them?" },
        { role: "customer", text: "Yes, please send them right away!" },
      ],
    };
  }

  function createTVConversation(customerIdx, scenarioIdx) {
    const issues = [
      "My TV screen has developed vertical lines. It's a Samsung 55 inch OLED.",
      "TV is not turning on. The power light blinks but the screen stays black.",
      "My smart TV is very slow and keeps freezing on every app.",
    ];
    const issue = issues[scenarioIdx % issues.length];

    return {
      customerIdx,
      messages: [
        { role: "customer", text: issue },
        { role: "bot", text: "I understand how frustrating that can be. Let me help you book a diagnostic service. What's your location and preferred time?" },
        { role: "customer", text: pick(BENGALURU_AREAS) + ". Can someone come tomorrow morning?" },
        { role: "bot", text: "Our TV specialist can visit tomorrow between 10 AM and 12 PM. We repair all major brands including Samsung, LG, Sony, and OnePlus. Shall I book it?" },
        { role: "customer", text: "Yes, 10 AM works. Thank you!" },
      ],
    };
  }

  function createFollowUpConversation(customerIdx, scenarioIdx) {
    const followups = [
      { cust: "Hi, I wanted to follow up on my AC repair last week. It's working better now, thanks!", bot: "We're glad to hear that! Your repair comes with a 30-day warranty, so if you face any issues, just let us know. Would you like to leave a review?" },
      { cust: "The washing machine repair was great! Quick and professional.", bot: "Thank you for your kind words! We'll pass along your feedback to the technician. Your repair is covered by our 30-day warranty. Anything else we can help with?" },
      { cust: "I want to reschedule my refrigerator repair from tomorrow to Friday.", bot: "No problem at all! Let me check Friday's availability. We have slots at 9-11 AM or 2-4 PM. Which works better for you?" },
      { cust: "Do you offer any discount for senior citizens?", bot: "Yes, we offer a 5% discount for senior citizens on all repair services. Just mention it when the technician arrives. Would you like to book a service?" },
      { cust: "Thanks for the quick service yesterday. The TV is working perfectly now!", bot: "That's wonderful to hear! Our technician takes great pride in quality work. Remember, you have a 30-day warranty on all repairs. Have a great day! 😊" },
    ];
    const f = followups[scenarioIdx % followups.length];

    return {
      customerIdx,
      messages: [
        { role: "customer", text: f.cust },
        { role: "bot", text: f.bot },
      ],
    };
  }

  // Generate 35 conversations across all appliance types
  let scenarioIdx = 0;

  // AC conversations (6)
  for (let i = 0; i < 6; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    conversations.push(createACConversation(customerIdx, scenarioIdx++));
  }

  // Washing Machine conversations (5)
  for (let i = 0; i < 5; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    conversations.push(createWMConversation(customerIdx, scenarioIdx++));
  }

  // Refrigerator conversations (5)
  for (let i = 0; i < 5; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    conversations.push(createRFConversation(customerIdx, scenarioIdx++));
  }

  // Microwave conversations (4)
  for (let i = 0; i < 4; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    conversations.push(createMWConversation(customerIdx, scenarioIdx++));
  }

  // RO Purifier conversations (4)
  for (let i = 0; i < 4; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    conversations.push(createROConversation(customerIdx, scenarioIdx++));
  }

  // Geyser conversations (4)
  for (let i = 0; i < 4; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    conversations.push(createGEConversation(customerIdx, scenarioIdx++));
  }

  // TV conversations (4)
  for (let i = 0; i < 4; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    conversations.push(createTVConversation(customerIdx, scenarioIdx++));
  }

  // Follow-up conversations (3)
  for (let i = 0; i < 3; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    conversations.push(createFollowUpConversation(customerIdx, scenarioIdx++));
  }

  // Shuffle to mix up appliance types
  return conversations.sort(() => Math.random() - 0.5);
}

// ─── Generator: Timeline entries (50) ─────────────────────────────────────
function generateTimeline(bookingCount, customers) {
  const actions = [
    "booking_created", "status_change", "technician_assigned",
    "customer_called", "payment_received", "ai_booked_service",
    "job_completed", "customer_reviewed", "rescheduled", "invoice_sent"
  ];

  const timeline = [];

  // Generate 50 timeline entries referencing random bookings
  for (let i = 0; i < 50; i++) {
    const bookingId = randInt(1, Math.max(bookingCount, 50));
    const action = pick(actions);
    const daysAgo = randInt(0, 60);

    let oldValue = null;
    let newValue = null;
    let notes = null;

    switch (action) {
      case "status_change":
        oldValue = pick(["open", "accepted", "assigned"]);
        newValue = pick(["accepted", "assigned", "on_the_way", "arrived", "completed"]);
        notes = "Status updated by system";
        break;
      case "technician_assigned":
        newValue = pick(["Rajesh Kumar", "Suresh Patel", "Amit Singh", "Vijay Sharma", "Deepa Iyer", "Prakash Rao", "Manjunath Hegde", "Kavita Nair"]);
        notes = "Technician assigned to job";
        break;
      case "payment_received":
        newValue = "₹" + randInt(500, 3000);
        notes = "Payment received via online transfer";
        break;
      case "ai_booked_service":
        notes = "AI assistant automatically booked this service via WhatsApp";
        break;
      case "job_completed":
        notes = "Job completed successfully. Customer satisfied.";
        break;
      case "customer_reviewed":
        notes = "★★★★★ \"Great service, very professional!\"";
        break;
      case "rescheduled":
        oldValue = "Original slot";
        newValue = "Rescheduled to " + pick(["next day", "2 days later", "following week"]);
        notes = "Customer requested reschedule";
        break;
      case "invoice_sent":
        newValue = "INV-DEMO-" + String(randInt(100, 999));
        notes = "Invoice sent to customer";
        break;
      case "booking_created":
        notes = "Booking created via " + pick(["WhatsApp", "phone call", "website", "walk-in"]);
        break;
    }

    timeline.push({
      bookingId,
      action,
      oldValue,
      newValue,
      actorType: pick(["system", "shop", "customer"]),
      notes,
      daysAgo,
    });
  }

  // Sort by most recent first
  timeline.sort((a, b) => a.daysAgo - b.daysAgo);
  return timeline;
}

// ─── Generator: Shop Notifications (20) ────────────────────────────────────
function generateNotifications() {
  const notifications = [
    { type: "booking", title: "New Booking Received", message: "AC Repair at Indiranagar. Customer needs urgent service.", icon: "🔧" },
    { type: "booking", title: "Booking Completed", message: "Washing machine repair at Koramangala completed successfully.", icon: "✅" },
    { type: "ai", title: "AI Booked Service", message: "AI assistant booked a refrigerator service via WhatsApp conversation.", icon: "🤖" },
    { type: "payment", title: "Payment Received", message: "Customer paid ₹1,200 for AC service via online transfer.", icon: "💰" },
    { type: "review", title: "New 5-Star Review", message: "Rajesh Kumar received a 5-star review from customer in Whitefield.", icon: "⭐" },
    { type: "booking", title: "Technician Assigned", message: "Amit Singh assigned to TV repair job in JP Nagar.", icon: "👨‍🔧" },
    { type: "ai", title: "WhatsApp Conversation Started", message: "New customer messaged on WhatsApp about geyser not heating.", icon: "💬" },
    { type: "booking", title: "Job On The Way", message: "Suresh Patel is on the way to a washing machine job in HSR Layout.", icon: "🚗" },
    { type: "payment", title: "Subscription Renewed", message: "Monthly subscription of ₹1,299 renewed successfully.", icon: "🔄" },
    { type: "booking", title: "Booking Cancelled", message: "Customer cancelled RO service appointment due to schedule conflict.", icon: "❌" },
    { type: "ai", title: "AI Learned New Issue", message: "AI added 'microwave sparking' to its knowledge base for better responses.", icon: "🧠" },
    { type: "booking", title: "Job Completed Early", message: "AC installation in Electronic City completed ahead of schedule.", icon: "🏆" },
    { type: "review", title: "Customer Feedback", message: "\"Very professional team. Fixed my fridge in 30 minutes!\" - Priya S.", icon: "💬" },
    { type: "booking", title: "Peak Time Alert", message: "5 open jobs waiting for assignment. Consider adjusting technician schedules.", icon: "⚡" },
    { type: "payment", title: "Invoice Generated", message: "Invoice INV-2024-0892 generated for AC Gas Refill service.", icon: "📄" },
    { type: "ai", title: "WhatsApp AI Active", message: "AI handled 12 customer queries today. 3 converted to bookings.", icon: "📊" },
    { type: "booking", title: "Reschedule Request", message: "Customer requested to move refrigerator repair from tomorrow to Friday.", icon: "📅" },
    { type: "team", title: "Technician Available", message: "Prakash Rao has completed his current job and is available for new assignments.", icon: "🟢" },
    { type: "payment", title: "Monthly Report Ready", message: "August report: 47 jobs completed, ₹62,350 revenue. Download the report.", icon: "📈" },
    { type: "booking", title: "Follow-up Reminder", message: "AC service warranty expiring soon for customer in Malleshwaram.", icon: "🔔" },
  ];

  return notifications.map((n, i) => ({
    type: n.type,
    title: n.title,
    message: n.message,
    is_read: i > 7, // first 7 unread, rest read
    daysAgo: randInt(0, 30),
    metadata: { icon: n.icon },
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// GENERATE ALL DATA
// ═════════════════════════════════════════════════════════════════════════════

const CUSTOMERS = generateCustomers(100);
const TECHNICIANS = generateTechnicians();
const BOOKINGS = generateBookings(CUSTOMERS, TECHNICIANS.length);
const CONVERSATIONS = generateConversations(CUSTOMERS);
const TIMELINE = generateTimeline(BOOKINGS.length, CUSTOMERS);
const NOTIFICATIONS = generateNotifications();

// ═════════════════════════════════════════════════════════════════════════════
// DEMO OBJECT
// ═════════════════════════════════════════════════════════════════════════════

const DEMO = {
  // ── Demo Shop (Bengaluru) ─────────────────────────────────────────────────
  shop: {
    shop_name: "CoolCare Demo Services",
    owner_name: "Rahul Sharma",
    email: "demo@coolcare.demo",
    mobile: "+919999988888",
    address: "12, 1st Main Road, Indiranagar",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560038",
    service_areas: BENGALURU_AREAS.slice(0, 15),
    services_offered: [
      "AC Repair & Service",
      "Refrigerator Repair",
      "Washing Machine Repair",
      "Microwave Repair",
      "Geyser Repair",
      "TV Repair",
      "RO Purifier Service",
      "Dishwasher Repair",
      "Chimney Repair",
    ],
    logo_url: "/demo-logo.svg",
    language: "en",
    timezone: "Asia/Kolkata",
    currency: "INR",
    gst_number: "29ABCDE1234F1Z5",
    business_hours: {
      mon: { open: "08:00", close: "20:00" },
      tue: { open: "08:00", close: "20:00" },
      wed: { open: "08:00", close: "20:00" },
      thu: { open: "08:00", close: "20:00" },
      fri: { open: "08:00", close: "20:00" },
      sat: { open: "09:00", close: "18:00" },
      sun: { open: "10:00", close: "16:00" },
    },
    whatsapp_number: "+919999977777",
  },

  // ── AI Settings ────────────────────────────────────────────────────────────
  ai_settings: {
    greeting_message:
      "👋 Namaste! Welcome to CoolCare Demo Services! I'm your AI assistant. I can help you book service appointments for AC, refrigerator, washing machine, microwave, geyser, TV, RO purifier, and more. How can I help you today?",
    fallback_response:
      "I'm sorry, I couldn't understand that. Let me transfer you to a human agent. Alternatively, you can call us directly at +919999988888.",
    knowledge_base:
      "We service all major brands: Samsung, LG, Whirlpool, Godrej, Voltas, Daikin, Hitachi, Blue Star, Lloyd, Sony, Panasonic, Bosch, IFB, Onida, Haier, Havells, Croma, and more. Standard visit charge is ₹299 which includes diagnosis. Parts and gas refills are extra. Most repairs are completed within 24 hours. We offer a 30-day warranty on all repairs and 90-day warranty on spare parts. Service areas: all major Bengaluru localities including Indiranagar, Koramangala, Whitefield, JP Nagar, Jayanagar, HSR Layout, Electronic City, Marathahalli, and surrounding areas.",
    transfer_to_human: true,
    working_days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    supported_services: [
      "AC Repair & Service",
      "Refrigerator Repair",
      "Washing Machine Repair",
      "Microwave Repair",
      "Geyser Repair",
      "TV Repair",
      "RO Purifier Service",
      "Dishwasher Repair",
      "Chimney Repair",
    ],
  },

  // ── Technicians (8) ──────────────────────────────────────────────────────
  technicians: TECHNICIANS,

  // ── Customers (100) ──────────────────────────────────────────────────────
  customers: CUSTOMERS,

  // ── Bookings (200+) ───────────────────────────────────────────────────────
  bookings: BOOKINGS,

  // ── WhatsApp Conversations (35) ──────────────────────────────────────────
  conversations: CONVERSATIONS,

  // ── Timeline / Recent Activity (50) ──────────────────────────────────────
  timeline: TIMELINE,

  // ── Shop Notifications (20) ──────────────────────────────────────────────
  notifications: NOTIFICATIONS,
};

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build a timestamp relative to now with realistic time-of-day variation.
 * @param {number} days  How many days ago (0 = today)
 * @returns {string} ISO 8601 timestamp
 */
function ago(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  // Random hour between 7am and 9pm (service hours)
  d.setHours(7 + Math.floor(Math.random() * 14));
  d.setMinutes(Math.floor(Math.random() * 60));
  d.setSeconds(Math.floor(Math.random() * 60));
  return d.toISOString();
}

/**
 * Generate a revenue chart dataset for the last 30 days.
 * Revenue is calculated from completed bookings.
 * @returns {Array<{date: string, revenue: number, bookings: number}>}
 */
function generateRevenueChart() {
  const chart = [];
  // Count completed bookings by day
  const dailyStats = {};

  for (const b of BOOKINGS) {
    if (b.status === "completed" && b.final_cost && b.created_days_ago < 30) {
      const d = new Date();
      d.setDate(d.getDate() - b.created_days_ago);
      const dateStr = d.toISOString().slice(0, 10);
      if (!dailyStats[dateStr]) dailyStats[dateStr] = { revenue: 0, bookings: 0 };
      dailyStats[dateStr].revenue += b.final_cost;
      dailyStats[dateStr].bookings++;
    }
  }

  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const stats = dailyStats[dateStr] || { revenue: 0, bookings: 0 };
    chart.push({ date: dateStr, revenue: Math.round(stats.revenue * 100) / 100, bookings: stats.bookings });
  }

  return chart;
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═════════════════════════════════════════════════════════════════════════════

module.exports = { DEMO, ago, generateRevenueChart, pick, randInt };
