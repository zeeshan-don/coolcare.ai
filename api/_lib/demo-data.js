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
  const technicians = [
    {
      name: "Rajesh Kumar",
      phone: "+919876543201",
      email: "rajesh@coolcare.demo",
      services: ["AC Repair", "AC Service", "AC Installation", "Gas Refill", "Refrigerator Repair"],
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
      services: ["Washing Machine Repair", "Washing Machine Installation", "Dishwasher Repair", "Dryer Repair"],
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
      services: ["TV Repair", "TV Installation", "Microwave Repair", "Electronics Repair"],
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
      services: ["RO Purifier Service", "RO Installation", "Geyser Repair", "Geyser Installation", "Plumbing"],
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
      services: ["AC Repair", "AC Service", "Refrigerator Repair", "General Appliance Repair"],
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
      services: ["Washing Machine Repair", "Refrigerator Repair", "Microwave Repair", "General Appliance Repair"],
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
      services: ["AC Installation", "Geyser Installation", "Chimney Repair", "RO Purifier Service", "Plumbing"],
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
      services: ["TV Repair", "TV Installation", "Electronics Repair", "Microwave Repair", "Smart Home Setup"],
      specialization: ["TV Repair", "Electronics", "Microwave Repair", "Smart Home"],
      active: true,
      rating: 4.7,
      jobs_completed: 165,
      area: "Electronic City",
    },
  ];

  // ── Validate every technician has all required fields ─────────────────────
  const REQUIRED_TECH_FIELDS = ['name', 'phone', 'email', 'services', 'specialization', 'active'];
  for (const tech of technicians) {
    for (const field of REQUIRED_TECH_FIELDS) {
      if (tech[field] === undefined || tech[field] === null) {
        throw new Error(
          `[demo-data] Validation failed: technician "${tech.name}" is missing required field "${field}". ` +
          `All fields required: ${REQUIRED_TECH_FIELDS.join(', ')}`
        );
      }
    }
    if (!Array.isArray(tech.services) || tech.services.length === 0) {
      throw new Error(
        `[demo-data] Validation failed: technician "${tech.name}" has empty or invalid "services" field. ` +
        `Must be a non-empty array.`
      );
    }
  }

  return technicians;
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

  // ---- COMPLETED BOOKINGS (220) - spread across 365 days ----
  // These provide revenue history across 12 months with a growth trend.
  // Recent months are busier so the dashboard always shows a healthy
  // pipeline of jobs completed "today" and "this week".
  let completedId = 0;
  for (let monthOffset = 12; monthOffset >= 1; monthOffset--) {
    // More bookings in recent months (growth trend)
    const baseCount = monthOffset <= 1 ? 26 : Math.max(3, Math.floor(24 - (12 - monthOffset) * 0.9));
    const count = baseCount + randInt(-2, 3);

    for (let i = 0; i < count && completedId < 220; i++) {
      const customerIdx = randInt(0, customers.length - 1);
      const techIdx = randInt(0, techCount - 1);
      const service = pick(SERVICES);
      const area = pick(BENGALURU_AREAS);
      // Most recent month spreads across the last 30 days (including today)
      const daysInMonth = monthOffset === 1 ? randInt(0, 28) : monthOffset * 30 - randInt(0, 28);
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

  // Guarantee a few jobs completed *today* so the dashboard's
  // "Revenue Today" / "Completed Today" metrics are never empty.
  const todayServices = [SERVICES[0], SERVICES[2], SERVICES[10], SERVICES[8]];
  todayServices.forEach((service, i) => {
    const customerIdx = randInt(0, customers.length - 1);
    const cust = customers[customerIdx];
    cust.total_visits = (cust.total_visits || 0) + 1;
    cust.total_spent = (cust.total_spent || 0) + service.maxCost;
    bookings.push({
      customerIdx,
      techIdx: i % techCount,
      status: "completed",
      service: service.name,
      area: pick(BENGALURU_AREAS),
      cost: service.maxCost,
      final_cost: service.maxCost,
      created_days_ago: 0,
      completed_days_ago: 0,
      urgency: "today",
      priority: "normal",
    });
  });

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

  // ---- IN PROGRESS BOOKINGS (5) — repair lifecycle mid-flight ----
  for (let i = 0; i < 5; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    const techIdx = randInt(0, techCount - 1);
    const service = pick(SERVICES);
    const area = pick(BENGALURU_AREAS);
    const urgency = "urgent";

    bookings.push({
      customerIdx,
      techIdx,
      status: "in_progress",
      service: service.name,
      area,
      cost: null,
      final_cost: null,
      created_days_ago: 0,
      urgency,
      priority: "urgent",
    });
  }

  // ---- WAITING FOR PARTS BOOKINGS (3) ----
  for (let i = 0; i < 3; i++) {
    const customerIdx = randInt(0, customers.length - 1);
    const techIdx = randInt(0, techCount - 1);
    const service = pick(SERVICES);
    const area = pick(BENGALURU_AREAS);
    const urgency = "today";

    bookings.push({
      customerIdx,
      techIdx,
      status: "waiting_parts",
      service: service.name,
      area,
      cost: null,
      final_cost: null,
      created_days_ago: 0,
      urgency,
      priority: "high",
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
 * Deterministic timestamp generator — no random() needed, uses seed for variation.
 * This is cacheable and avoids the overhead of Math.random() calls.
 */
function deterministicAgo(days, seed) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const hour = 7 + ((seed || 0) % 14);
  const minute = ((seed || 0) * 13 + days * 7) % 60;
  d.setHours(hour, minute, (seed || 0) % 60);
  return d.toISOString();
}

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
// COMMAND CENTER — business KPIs, Today's Priorities, Business Health,
// AI Performance & Technician Performance.
// Deterministic + derived from BOOKINGS/TECHNICIANS/CONVERSATIONS so it stays
// cacheable. Mirrors the payload handleDashboard() computes for real shops.
// ═════════════════════════════════════════════════════════════════════════════
function buildCommandCenterData() {
  // ── Revenue & volume (today / yesterday / month) ─────────────────────────
  let revenueToday = 0;
  let revenueYesterday = 0;
  let todayBookings = 0;
  let monthlyRevenue = 0;
  let prevMonthRevenue = 0;
  let monthBookings = 0;
  let weekRevenue = 0;

  for (const b of BOOKINGS) {
    const days = b.created_days_ago;
    if (days < 1) todayBookings++;
    if (b.status === "completed" && b.final_cost) {
      if (days < 1) revenueToday += b.final_cost;
      else if (days < 2) revenueYesterday += b.final_cost;
      if (days >= 1 && days < 7) weekRevenue += b.final_cost;
      if (days < 30) monthlyRevenue += b.final_cost;
      else if (days < 60) prevMonthRevenue += b.final_cost;
    }
    if (days < 30) monthBookings++;
  }

  // Delta vs the 7-day average (robust even when yesterday had 0 completions)
  const prevAvgRevenue = Math.round(weekRevenue / 7);
  let revenueDeltaPct = prevAvgRevenue > 0 ? Math.round(((revenueToday - prevAvgRevenue) / prevAvgRevenue) * 100) : 0;
  revenueDeltaPct = Math.max(-99, Math.min(199, revenueDeltaPct)); // keep the number believable
  const monthGrowthPct =
    prevMonthRevenue > 0
      ? Math.round(((monthlyRevenue - prevMonthRevenue) / prevMonthRevenue) * 100)
      : monthlyRevenue > 0 ? 25 : 0;

  // ── AI pipeline (67% conversation→booking, matching demo analytics) ──────
  const aiConversationsToday = CONVERSATIONS.filter((c, i) => i % 4 === 0).length;
  const aiConversationsMonth = CONVERSATIONS.length;
  const aiBookingsToday = Math.round(aiConversationsToday * 0.67);
  const aiBookingsMonth = Math.round(aiConversationsMonth * 0.67);
  const humanTransfersToday = Math.max(0, Math.round(aiConversationsToday * 0.08));
  const humanTransfersMonth = Math.max(0, Math.round(aiConversationsMonth * 0.08));
  // 4 minutes per handled conversation + 20 minutes per AI-created booking
  const hoursSavedToday = Math.round((aiConversationsToday * 0.067 + aiBookingsToday * 0.33) * 10) / 10;
  const hoursSavedMonth = Math.round((aiConversationsMonth * 0.067 + aiBookingsMonth * 0.33) * 10) / 10;
  const avgResponseSeconds = 6 + (aiConversationsToday % 5); // 6–10s
  const aiSuccessRate = aiConversationsMonth > 0 ? Math.round((aiBookingsMonth / aiConversationsMonth) * 100) : 0;
  const satisfaction =
    Math.round((TECHNICIANS.reduce((s, t) => s + (t.rating || 0), 0) / Math.max(TECHNICIANS.length, 1)) * 10) / 10;

  // ── Technician availability ──────────────────────────────────────────────
  const busySet = new Set();
  for (const b of BOOKINGS) {
    if (["assigned", "on_the_way", "arrived", "in_progress", "waiting_parts"].includes(b.status) && b.techIdx != null) busySet.add(b.techIdx);
  }
  const techniciansFree = Math.max(0, TECHNICIANS.length - busySet.size);
  const techniciansBusy = busySet.size;

  // ── Waiting / overdue / payments ──────────────────────────────────────────
  const jobsWaiting = BOOKINGS.filter((b) => ["open", "accepted"].includes(b.status)).length;
  const waitingConfirmation = BOOKINGS.filter((b) => b.status === "open").length;
  const overdueJobs = BOOKINGS.filter(
    (b) => b.priority === "urgent" && ["open", "accepted"].includes(b.status) && b.created_days_ago >= 2
  ).length;
  const pendingPayments =
    BOOKINGS.filter((b) => b.status === "completed" && b.final_cost && b.created_days_ago <= 2).length + 1;

  // ── Today's Priorities ────────────────────────────────────────────────────
  const priorities = [];
  const plural = (n) => (n === 1 ? "" : "s");
  if (jobsWaiting > 0) {
    priorities.push({ level: "red", count: jobsWaiting, text: `${jobsWaiting} booking${plural(jobsWaiting)} waiting for technician assignment`, action: "Assign →", filter: "open", scrollTo: "bookings" });
  }
  if (overdueJobs > 0) {
    priorities.push({ level: "red", count: overdueJobs, text: `${overdueJobs} overdue repair${plural(overdueJobs)} need attention today`, action: "Review →", filter: "open", scrollTo: "bookings" });
  }
  if (waitingConfirmation > 0) {
    priorities.push({ level: "yellow", count: waitingConfirmation, text: `${waitingConfirmation} customer${plural(waitingConfirmation)} waiting for confirmation`, action: "Confirm →", filter: "open", scrollTo: "bookings" });
  }
  if (pendingPayments > 3) {
    priorities.push({ level: "yellow", count: pendingPayments, text: `${pendingPayments} payment${plural(pendingPayments)} pending collection`, action: "View →", scrollTo: "bookings" });
  }
  if (techniciansFree > 0) {
    priorities.push({ level: "green", count: techniciansFree, text: `${techniciansFree} technician${plural(techniciansFree)} available right now`, action: "Dispatch →", scrollTo: "widgets" });
  }
  priorities.push({
    level: "green",
    count: aiBookingsToday,
    text: `AI booked ${aiBookingsToday} job${plural(aiBookingsToday)} today · responding in ~${avgResponseSeconds}s`,
    action: "Details →",
    scrollTo: "widgets",
  });

  // ── Business Health ───────────────────────────────────────────────────────
  let healthScore = 100;
  healthScore -= Math.min(12, overdueJobs * 5);
  if (waitingConfirmation > 10) healthScore -= 5;
  if (techniciansFree === 0) healthScore -= jobsWaiting > 0 ? 2 : 5; // fully booked is a good problem
  if (pendingPayments > 4) healthScore -= 3;
  if (monthGrowthPct < 0) healthScore -= 8;
  healthScore = Math.max(55, Math.min(98, healthScore));
  const healthLabel = healthScore >= 90 ? "Excellent" : healthScore >= 75 ? "Great" : healthScore >= 60 ? "Fair" : "At Risk";
  const businessHealth = {
    score: healthScore,
    label: healthLabel,
    checks: [
      { ok: aiConversationsToday > 0, label: "AI responding normally" },
      { ok: overdueJobs === 0, label: "No overdue repairs" },
      { ok: avgResponseSeconds < 20, label: `Response time under 20s (${avgResponseSeconds}s)` },
      { ok: monthGrowthPct >= 0, label: monthGrowthPct >= 0 ? "Revenue growing this month" : "Revenue declined this month" },
      { ok: techniciansFree > 0, label: techniciansFree > 0 ? `${techniciansFree} technician${plural(techniciansFree)} ready to dispatch` : "No technicians free" },
    ],
  };

  // ── AI Performance ────────────────────────────────────────────────────────
  const aiPerformance = {
    conversationsToday: aiConversationsToday,
    conversationsMonth: aiConversationsMonth,
    bookingsCreatedToday: aiBookingsToday,
    bookingsCreatedMonth: aiBookingsMonth,
    humanTransfersToday: humanTransfersToday,
    humanTransfersMonth: humanTransfersMonth,
    hoursSavedToday: hoursSavedToday,
    hoursSavedMonth: hoursSavedMonth,
    successRate: aiSuccessRate,
    avgResponseSeconds: avgResponseSeconds,
  };

  // ── Technician Performance (last 30 days) ─────────────────────────────────
  const techStats = TECHNICIANS.map((t, i) => {
    let repairs = 0;
    let revenue = 0;
    for (const b of BOOKINGS) {
      if (b.techIdx === i && b.status === "completed" && b.created_days_ago < 30) {
        repairs++;
        revenue += b.final_cost || 0;
      }
    }
    return {
      id: i + 1,
      name: t.name,
      rating: t.rating || 0,
      repairs,
      revenue: Math.round(revenue),
      busy: busySet.has(i),
      area: t.area || "",
      specialization: (t.specialization && t.specialization[0]) || "",
    };
  }).sort((a, b) => b.revenue - a.revenue || b.repairs - a.repairs);

  const top = techStats[0] || { name: "—", rating: 0, repairs: 0, revenue: 0, busy: false };
  const technicianPerformance = { top, list: techStats };

  return {
    kpis: {
      revenueToday: Math.round(revenueToday),
      revenueYesterday: Math.round(revenueYesterday),
      revenueDeltaPct,
      monthlyRevenue: Math.round(monthlyRevenue),
      monthGrowthPct,
      todayBookings,
      monthBookings,
      jobsWaiting,
      overdueJobs,
      techniciansFree,
      technicianCount: TECHNICIANS.length,
      pendingPayments,
      satisfaction,
      // ── Repair lifecycle analytics (demo values mirror a healthy shop) ──
      jobsPending: BOOKINGS.filter((b) => ["open", "accepted"].includes(b.status)).length,
      jobsAssigned: BOOKINGS.filter((b) => b.status === "assigned").length,
      jobsInProgress: BOOKINGS.filter((b) => ["on_the_way", "arrived", "in_progress", "waiting_parts"].includes(b.status)).length,
      jobsCompleted: BOOKINGS.filter((b) => b.status === "completed").length,
      jobsCancelled: BOOKINGS.filter((b) => ["cancelled", "rejected"].includes(b.status)).length,
      avgCompletionHours: 3.4,
      avgTechResponseMinutes: 42,
      aiConversationsToday,
      aiBookingsToday,
      aiSuccessRate,
      hoursSavedToday,
      avgResponseSeconds,
    },
    priorities,
    businessHealth,
    aiPerformance,
    technicianPerformance,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// PERFORMANCE CACHE — demo data is identical for every visitor, so we cache
// the pre-computed responses aggressively to avoid recomputation.
// ═════════════════════════════════════════════════════════════════════════════

/** @type {{ dashboard: null|object, dashboardByParams: Map<string,object>, bookingDetails: Map<number,object>, revenueCharts: Map<string,object>, lastCachedAt: null|number }} */
const DEMO_CACHE = {
  dashboard: null,
  dashboardByParams: new Map(),
  bookingDetails: new Map(),
  revenueCharts: new Map(),
  lastCachedAt: null,
};

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function isCacheValid() {
  return DEMO_CACHE.lastCachedAt && (Date.now() - DEMO_CACHE.lastCachedAt) < CACHE_TTL;
}

function invalidateDemoCache() {
  DEMO_CACHE.dashboard = null;
  DEMO_CACHE.dashboardByParams.clear();
  DEMO_CACHE.bookingDetails.clear();
  DEMO_CACHE.revenueCharts.clear();
  DEMO_CACHE.lastCachedAt = null;
}

// ═════════════════════════════════════════════════════════════════════════════
// TIMING HELPER
// ═════════════════════════════════════════════════════════════════════════════

const PERF_LOG = [];

function perfMark(label) {
  PERF_LOG.push({ label, time: Date.now() });
}

function perfReport(label) {
  if (PERF_LOG.length === 0) return;
  const start = PERF_LOG[0].time;
  const lines = PERF_LOG.map((m, i) => {
    const delta = i === 0 ? 0 : m.time - PERF_LOG[i - 1].time;
    return `  [${i}] ${m.label}: +${delta}ms`;
  });
  const total = Date.now() - start;
  console.log(`[demo/perf] ${label}: total=${total}ms\n${lines.join('\n')}`);
  PERF_LOG.length = 0;
}


// ═════════════════════════════════════════════════════════════════════════════
// API RESPONSE BUILDERS — returns exact JSON structure frontend expects
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build a complete dashboard API response for demo mode.
 * Uses aggressive caching since demo data is identical for every visitor.
 * Matches the structure returned by handleDashboard() in api/shop.js
 */
function buildDemoDashboardResponse(params) {
  perfMark('buildDemoDashboardResponse start');

  params = params || {};
  const page = params.page || 1;
  const limit = params.limit || 20;
  const filterStatus = params.status || "all";
  const search = params.search || "";

  // ── Cache key includes all filter params ─────────────────────────────────
  const cacheKey = `${page}:${limit}:${filterStatus}:${search}`;
  const cached = DEMO_CACHE.dashboardByParams.get(cacheKey);
  if (cached && isCacheValid()) {
    perfMark('cache HIT (dashboard params)');
    perfReport('buildDemoDashboardResponse');
    return JSON.parse(JSON.stringify(cached));
  }

  perfMark('cache MISS, building response');

  const now = new Date();

  // ── Build bookings in DB-returned format ─────────────────────────────────
  function bookingToRow(b, idx) {
    const cust = DEMO.customers[b.customerIdx];
    const techName = b.techIdx != null ? DEMO.technicians[b.techIdx]?.name : null;
    const bCreatedAt = new Date(now.getTime() - b.created_days_ago * 86400000);
    // Use stable hour based on index to avoid random() overhead
    const hour = 7 + ((idx + b.created_days_ago) % 14);
    bCreatedAt.setHours(hour, (idx * 17) % 60);

    return {
      id: idx + 1,
      customer_number: cust.phone,
      customer_name: cust.name,
      service_type: b.service,
      area: b.area,
      address: cust.address || b.area,
      urgency: b.urgency,
      status: b.status,
      technician_id: b.techIdx != null ? b.techIdx + 1 : null,
      technician_name: techName,
      assigned_technician_name: techName,
      assigned_technician_phone: techName ? DEMO.technicians[b.techIdx]?.phone : null,
      technician_notes: b.status === "completed" ? "Job completed successfully. Customer satisfied." : null,
      estimated_cost: b.status !== "open" && b.status !== "accepted" ? (b.cost || Math.floor((b.final_cost || 1000) * 0.7)) : null,
      final_cost: b.final_cost || null,
      priority: b.priority || "normal",
      customer_notes: "Customer reported " + b.service.toLowerCase(),
      invoice_number: b.status === "completed" ? "INV-DEMO-" + String(idx + 1).padStart(4, "0") : null,
      created_at: bCreatedAt.toISOString(),
      updated_at: new Date(now.getTime() - Math.max(0, b.created_days_ago - 1) * 86400000).toISOString(),
    };
  }

  // ── Status counts ────────────────────────────────────────────────────────
  const statusCounts = { open: 0, accepted: 0, rejected: 0, assigned: 0, on_the_way: 0, arrived: 0, in_progress: 0, waiting_parts: 0, completed: 0, cancelled: 0, payment_received: 0 };
  for (const b of BOOKINGS) {
    if (statusCounts[b.status] !== undefined) statusCounts[b.status]++;
  }

  perfMark('status counts done');

  // ── Revenue stats ────────────────────────────────────────────────────────
  let totalRevenue = 0;
  let monthlyRevenue = 0;
  let weeklyRevenue = 0;
  let completedToday = 0;
  let todayBookings = 0;
  let monthBookings = 0;

  for (const b of BOOKINGS) {
    const bDate = new Date(now.getTime() - b.created_days_ago * 86400000);
    const daysDiff = Math.floor((now - bDate) / 86400000);

    if (b.status === "completed" && b.final_cost) {
      totalRevenue += b.final_cost;
      if (daysDiff < 30) monthlyRevenue += b.final_cost;
      if (daysDiff < 7) weeklyRevenue += b.final_cost;
    }
    if (b.created_days_ago < 1) {
      todayBookings++;
      if (b.status === "completed") completedToday++;
    }
    if (b.created_days_ago < 30) monthBookings++;
  }

  const pendingJobs = BOOKINGS.filter(b =>
    ["open", "accepted", "assigned", "on_the_way", "arrived", "in_progress", "waiting_parts"].includes(b.status)
  ).length;

  perfMark('revenue stats done');

  // ── Revenue chart (30 days) ──────────────────────────────────────────────
  const revenueChart = generateRevenueChart();
  perfMark('revenue chart done');

  // ── Command center payload (KPIs, priorities, health, AI & tech perf) ────
  const commandCenter = buildCommandCenterData();
  perfMark('command center done');

  // ── Activity feed (deterministic, cacheable) ─────────────────────────────
  const activityFeed = TIMELINE.slice(0, 20).map((t, i) => {
    const cust = CUSTOMERS[t.bookingId % CUSTOMERS.length];
    return {
      id: i + 1,
      bookingId: t.bookingId,
      action: t.action,
      oldValue: t.oldValue,
      newValue: t.newValue,
      customerName: cust.name,
      customerNumber: cust.phone,
      serviceType: SERVICES[t.bookingId % SERVICES.length].name,
      createdAt: deterministicAgo(t.daysAgo || i, i),
    };
  });

  perfMark('activity feed done');

  // ── Customer history ─────────────────────────────────────────────────────
  const customerVisitMap = {};
  for (const b of BOOKINGS) {
    if (b.status === "completed") {
      const cust = CUSTOMERS[b.customerIdx];
      if (!customerVisitMap[cust.phone]) {
        customerVisitMap[cust.phone] = {
          customer_name: cust.name,
          customer_number: cust.phone,
          visit_count: 0,
          total_spent: 0,
          first_visit: null,
          last_visit: null,
        };
      }
      const entry = customerVisitMap[cust.phone];
      entry.visit_count++;
      entry.total_spent += b.final_cost || 0;
      const bDate = deterministicAgo(b.created_days_ago, b.customerIdx);
      if (!entry.last_visit || bDate > entry.last_visit) entry.last_visit = bDate;
      if (!entry.first_visit || bDate < entry.first_visit) entry.first_visit = bDate;
    }
  }
  const customerHistory = Object.values(customerVisitMap)
    .sort((a, b) => b.visit_count - a.visit_count)
    .slice(0, 20)
    .map(c => ({
      name: c.customer_name,
      phone: c.customer_number,
      visits: c.visit_count,
      lastVisit: c.last_visit || deterministicAgo(0, 0),
      firstVisit: c.first_visit || deterministicAgo(30, 0),
      totalSpent: c.total_spent,
    }));

  perfMark('customer history done');

  // ── Filter bookings by status/search ─────────────────────────────────────
  let filteredBookings = BOOKINGS;
  if (filterStatus !== "all") {
    filteredBookings = BOOKINGS.filter(b => b.status === filterStatus);
  }
  if (search) {
    const q = search.toLowerCase();
    filteredBookings = filteredBookings.filter(b => {
      const cust = CUSTOMERS[b.customerIdx];
      return cust.name.toLowerCase().includes(q) || cust.phone.includes(q);
    });
  }

  // ── Paginate ─────────────────────────────────────────────────────────────
  const total = filteredBookings.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const paginated = filteredBookings.slice(offset, offset + limit);

  // ── Recent customers ─────────────────────────────────────────────────────
  const recentCustomers = Object.values(customerVisitMap)
    .sort((a, b) => (b.last_visit || "") > (a.last_visit || "") ? 1 : -1)
    .slice(0, 10)
    .map(c => ({
      name: c.customer_name,
      phone: c.customer_number,
      lastBooking: c.last_visit,
    }));

  // ── Weekly bookings ──────────────────────────────────────────────────────
  const weeklyBookings = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const count = BOOKINGS.filter(b => b.created_days_ago === i).length;
    weeklyBookings.push({ date: dateStr, count });
  }

  const result = {
    shop: {
      id: 1,
      shop_name: DEMO.shop.shop_name,
      owner_name: DEMO.shop.owner_name,
      email: DEMO.shop.email,
      mobile: DEMO.shop.mobile,
      city: DEMO.shop.city,
      services_offered: DEMO.shop.services_offered,
      service_areas: DEMO.shop.service_areas,
      role: "owner",
    },
    counts: statusCounts,
    bookings: paginated.map((b, i) => bookingToRow(b, offset + i)),
    pagination: { page, limit, total, totalPages },
    stats: {
      todayBookings,
      pendingJobs,
      completedToday,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      monthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
      weeklyRevenue: Math.round(weeklyRevenue * 100) / 100,
      monthBookings,
    },
    weeklyBookings,
    revenueChart,
    activityFeed,
    customerHistory,
    recentCustomers,
    ...commandCenter,
    subscription: {
      id: 1,
      repair_shop_id: 1,
      plan_id: 1,
      plan_name: "pro",
      plan_display: "Pro",
      features: ["AI Chatbot", "WhatsApp Integration", "Unlimited Bookings", "Team Accounts", "Analytics"],
      status: "active",
      billing_cycle: "yearly",
      gateway: "demo",
      gateway_sub_id: "demo-sub-001",
      amount_paid: 12470,
      currency: "INR",
      current_period_start: new Date(now.getTime() - 86400000 * 30).toISOString(),
      current_period_end: new Date(now.getTime() + 86400000 * 335).toISOString(),
      created_at: new Date(now.getTime() - 86400000 * 30).toISOString(),
    },
    subscriptionRequired: false,
    subscriptionStatus: "active",
    approvalStatus: "approved",
    rejectionReason: null,
    isDemo: true,
  };

  // ── Cache the result ─────────────────────────────────────────────────────
  DEMO_CACHE.dashboardByParams.set(cacheKey, JSON.parse(JSON.stringify(result)));
  if (!DEMO_CACHE.lastCachedAt) {
    DEMO_CACHE.lastCachedAt = Date.now();
    DEMO_CACHE.dashboard = JSON.parse(JSON.stringify(result));
  }

  perfMark('response built and cached');
  perfReport('buildDemoDashboardResponse');

  return result;
}

/**
 * Build a booking detail response for demo mode.
 * Uses caching.
 * Matches handleBookingDetail() in api/shop.js
 */
function buildDemoBookingDetailResponse(bookingId) {
  const idx = bookingId - 1;
  if (idx < 0 || idx >= BOOKINGS.length) return null;

  const b = BOOKINGS[idx];
  const cust = DEMO.customers[b.customerIdx];
  const techName = b.techIdx != null ? DEMO.technicians[b.techIdx]?.name : null;
  const techPhone = b.techIdx != null ? DEMO.technicians[b.techIdx]?.phone : null;
  const now = new Date();
  const bCreatedAt = new Date(now.getTime() - b.created_days_ago * 86400000);
  bCreatedAt.setHours(7 + Math.floor(Math.random() * 14), Math.floor(Math.random() * 60));

  const booking = {
    id: bookingId,
    customer_number: cust.phone,
    customer_name: cust.name,
    service_type: b.service,
    area: b.area,
    address: cust.address || b.area,
    urgency: b.urgency,
    status: b.status,
    technician_id: b.techIdx != null ? b.techIdx + 1 : null,
    technician_name: techName,
    assigned_technician_name: techName,
    assigned_technician_phone: techPhone,
    technician_notes: b.status === "completed" ? "Job completed successfully. All issues resolved. Customer satisfied." : null,
    estimated_cost: b.status !== "open" && b.status !== "accepted" ? (b.cost || Math.floor((b.final_cost || 1000) * 0.7)) : null,
    final_cost: b.final_cost || null,
    priority: b.priority || "normal",
    customer_notes: "Customer reported " + b.service.toLowerCase(),
    invoice_number: b.status === "completed" ? "INV-DEMO-" + String(bookingId).padStart(4, "0") : null,
    created_at: bCreatedAt.toISOString(),
    updated_at: new Date(now.getTime() - Math.max(0, b.created_days_ago - 1) * 86400000).toISOString(),
    shop_name: DEMO.shop.shop_name,
  };

  // Timeline entries for this booking
  const timeline = [{
    id: 1,
    booking_id: bookingId,
    action: "booking_created",
    old_value: null,
    new_value: null,
    actor_type: "system",
    notes: "Booking created via " + pick(["WhatsApp", "phone call", "website"]),
    created_at: bCreatedAt.toISOString(),
  }];

  if (b.status !== "open") {
    timeline.push({
      id: 2,
      booking_id: bookingId,
      action: "status_change",
      old_value: "open",
      new_value: b.status === "accepted" ? "accepted" : "accepted",
      actor_type: "shop",
      notes: "Booking accepted by shop",
      created_at: new Date(bCreatedAt.getTime() + 3600000).toISOString(),
    });
  }
  if (b.techIdx != null) {
    timeline.push({
      id: 3,
      booking_id: bookingId,
      action: "technician_assigned",
      old_value: null,
      new_value: techName,
      actor_type: "shop",
      notes: "Technician assigned to job",
      created_at: new Date(bCreatedAt.getTime() + 7200000).toISOString(),
    });
  }

  // Active repair stages (arrived → in progress → waiting for parts)
  if (["arrived", "in_progress", "waiting_parts"].includes(b.status)) {
    timeline.push({
      id: 4,
      booking_id: bookingId,
      action: "status_change",
      old_value: "on_the_way",
      new_value: "arrived",
      actor_type: "technician",
      notes: "Technician arrived at the customer's location",
      created_at: new Date(bCreatedAt.getTime() + 10800000).toISOString(),
    });
  }
  if (b.status === "in_progress") {
    timeline.push({
      id: 5,
      booking_id: bookingId,
      action: "status_change",
      old_value: "arrived",
      new_value: "in_progress",
      actor_type: "technician",
      notes: "Repair started",
      created_at: new Date(bCreatedAt.getTime() + 12600000).toISOString(),
    });
  }
  if (b.status === "waiting_parts") {
    timeline.push({
      id: 5,
      booking_id: bookingId,
      action: "status_change",
      old_value: "in_progress",
      new_value: "waiting_parts",
      actor_type: "technician",
      notes: "Waiting for parts to arrive",
      created_at: new Date(bCreatedAt.getTime() + 12600000).toISOString(),
    });
  }
  if (b.status === "payment_received") {
    timeline.push({
      id: 6,
      booking_id: bookingId,
      action: "status_change",
      old_value: "completed",
      new_value: "payment_received",
      actor_type: "system",
      notes: "Payment received",
      created_at: new Date(bCreatedAt.getTime() + 18000000).toISOString(),
    });
  }
  if (b.status === "completed") {
    timeline.push({
      id: 4,
      booking_id: bookingId,
      action: "job_completed",
      old_value: "arrived",
      new_value: "completed",
      actor_type: "technician",
      notes: "Job completed successfully. Customer satisfied.",
      created_at: new Date(bCreatedAt.getTime() + 14400000).toISOString(),
    });
    timeline.push({
      id: 5,
      booking_id: bookingId,
      action: "payment_received",
      old_value: null,
      new_value: "₹" + b.final_cost,
      actor_type: "system",
      notes: "Payment received via online transfer",
      created_at: new Date(bCreatedAt.getTime() + 18000000).toISOString(),
    });
  }

  const technicians = TECHNICIANS.map((t, i) => ({
    id: i + 1,
    name: t.name,
    phone: t.phone,
    specialization: t.specialization,
  }));

  return { booking, timeline, technicians };
}

/**
 * Build notifications response for demo mode.
 * Matches handleGetNotifications() in api/shop.js
 */
function buildDemoNotificationsResponse(limit) {
  limit = limit || 50;
  const rows = NOTIFICATIONS.slice(0, limit).map((n, i) => ({
    id: i + 1,
    repair_shop_id: 1,
    type: n.type,
    title: n.title,
    message: n.message,
    is_read: n.is_read,
    link: null,
    metadata: n.metadata || {},
    created_at: ago(n.daysAgo || i),
  }));

  const unreadCount = rows.filter(n => !n.is_read).length;

  return {
    notifications: rows,
    unreadCount,
    pagination: { page: 1, limit, total: rows.length },
    isDemo: true,
  };
}

/**
 * Build AI settings response for demo mode.
 */
function buildDemoAiSettingsResponse() {
  return {
    settings: DEMO.ai_settings,
    shop: DEMO.shop,
    isDemo: true,
  };
}

/**
 * Build shop settings response for demo mode.
 */
function buildDemoShopSettingsResponse() {
  return {
    shop: DEMO.shop,
    settings: {
      ...DEMO.shop,
      digest_enabled: true,
      digest_time: "08:00",
    },
    whatsappNumber: DEMO.shop.whatsapp_number,
    isDemo: true,
  };
}

/**
 * Build referrals response for demo mode.
 */
function buildDemoReferralsResponse() {
  return {
    referralCode: "COOLCARE-DEMO",
    shareLink: "https://coolcare.ai/shop-signup.html?ref=COOLCARE-DEMO",
    walletBalance: 1240,
    discountBalance: 500,
    stats: { total: 5, successful: 3, pending: 2, earnings: 750 },
    history: [
      { id: 1, referrer_shop_id: 1, referred_shop_id: 2, referral_code: "COOLCARE-DEMO", status: "completed", reward_value: 250, referred_shop_name: "Quick Fix Services", referred_email: "owner@quickfix.demo", created_at: ago(30) },
      { id: 2, referrer_shop_id: 1, referred_shop_id: 3, referral_code: "COOLCARE-DEMO", status: "completed", reward_value: 250, referred_shop_name: "ABC Repairs", referred_email: "info@abcrepairs.demo", created_at: ago(15) },
      { id: 3, referrer_shop_id: 1, referred_shop_id: 4, referral_code: "COOLCARE-DEMO", status: "completed", reward_value: 250, referred_shop_name: "City Appliance Service", referred_email: "admin@cityappliance.demo", created_at: ago(7) },
      { id: 4, referrer_shop_id: 1, referred_shop_id: 5, referral_code: "COOLCARE-DEMO", status: "pending", reward_value: 0, referred_shop_name: "Speedy Repairs", referred_email: "owner@speedy.demo", created_at: ago(2) },
      { id: 5, referrer_shop_id: 1, referred_shop_id: 6, referral_code: "COOLCARE-DEMO", status: "pending", reward_value: 0, referred_shop_name: "Elite Home Services", referred_email: "contact@elite.demo", created_at: ago(1) },
    ],
  };
}

/**
 * Build WhatsApp logs response for demo mode.
 */
function buildDemoWhatsAppLogsResponse() {
  const logs = CONVERSATIONS.slice(0, 20).map((conv, i) => {
    const cust = CUSTOMERS[conv.customerIdx];
    const lastMsg = conv.messages[conv.messages.length - 1];
    return {
      id: i + 1,
      customer_number: cust.phone,
      customer_name: cust.name,
      direction: "outbound",
      message_text: lastMsg.text,
      status: "delivered",
      created_at: ago(i * 2),
    };
  });

  return { logs, isDemo: true };
}

/**
 * Build WhatsApp status response for demo mode.
 */
function buildDemoWhatsAppStatusResponse() {
  return {
    connected: true,
    number: DEMO.shop.whatsapp_number,
    businessProfile: { name: DEMO.shop.shop_name, description: "Professional appliance repair service in Bengaluru" },
    qualityRating: "GREEN",
    messageLimit: "250K/24h",
    isDemo: true,
  };
}

/**
 * Build subscription page response for demo mode.
 */
function buildDemoSubscriptionResponse() {
  const now = new Date();
  const periodStart = new Date(now.getTime() - 86400000 * 30);
  const periodEnd = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());

  return {
    subscription: {
      id: 1,
      status: "active",
      plan_id: 1,
      plan_name: "Pro",
      billing_cycle: "yearly",
      amount_paid: 12470,
      currency: "INR",
      current_period_start: periodStart.toISOString(),
      current_period_end: periodEnd.toISOString(),
      gateway: "demo",
      features: ["AI Chatbot", "WhatsApp Integration", "Unlimited Bookings", "Team Accounts", "Analytics & Reports"],
    },
    plans: [
      { id: 1, name: "Starter", display_name: "Starter", price_monthly: 299, price_yearly: 2990, features: ["Basic Dashboard", "50 Bookings/mo", "Email Support"], is_active: true },
      { id: 2, name: "Pro", display_name: "Pro", price_monthly: 1299, price_yearly: 12470, features: ["AI Chatbot", "WhatsApp Integration", "Unlimited Bookings", "Team Accounts", "Analytics"], is_active: true },
      { id: 3, name: "Enterprise", display_name: "Enterprise", price_monthly: 4999, price_yearly: 49990, features: ["Everything in Pro", "Dedicated Account Manager", "Custom Integrations", "Priority Support", "Multi-Location"], is_active: true },
    ],
    payments: [
      { id: 1, invoice_number: "INV-DEMO-0000", amount: 12470, currency: "INR", status: "completed", gateway: "demo", description: "CoolCare Pro — Yearly Subscription (Demo)", created_at: ago(30) },
    ],
    isDemo: true,
  };
}

/**
 * Build widget settings response for demo mode.
 */
function buildDemoWidgetSettingsResponse() {
  return {
    settings: {
      enabled: true,
      business_name: DEMO.shop.shop_name,
      welcome_message: "👋 Hi there! Welcome to " + DEMO.shop.shop_name + "! How can we help you today?",
      offline_message: "We've received your request. Our team is currently offline. Your booking has been recorded and a technician will contact you once the business opens.",
      primary_color: "#22c55e",
      accent_color: "#16a34a",
      widget_position: "bottom-right",
      logo_url: DEMO.shop.logo_url || "",
      theme: "auto",
      show_avatar: true,
      auto_open: false,
      language: "en",
    },
    embedCode: `<script src="https://coolcare.ai/web-bot/widget.js" data-widget-id="${DEMO.shop.id || 1}"></script>`,
    isDemo: true,
  };
}

/**
 * Build sandbox status response for demo mode.
 * Mirrors the real sandbox-status payload with demo conversation data.
 */
function buildDemoSandboxStatusResponse() {
  return {
    shopId: DEMO.shop.id || 1,
    channel: "website",
    widgetId: DEMO.shop.id || 1,
    widgetEnabled: true,
    visitorId: "web_demo_visitor",
    aiStatus: "BOOKED",
    language: "en",
    bookingId: "42",
    bookingStatus: "assigned",
    technician: { name: "Vikram Kumar", phone: "+919876543210" },
    state: {
      status: "BOOKED",
      appliance: "AC",
      issue: "Not cooling",
      customer_name: "Rahul Sharma",
      area: "Indiranagar",
      urgency: "Today",
      human_handoff: false,
      selected_slot: null,
      image_urls: [],
      file_urls: [],
    },
    booking: {
      id: 42,
      status: "assigned",
      service_type: "AC — Not cooling",
      customer_name: "Rahul Sharma",
      address: "12, 1st Main Road, Indiranagar, Bengaluru",
      created_at: ago(1),
    },
    businessHours: DEMO.shop.business_hours,
    greetingMessage: `Hi 👋 Welcome to ${DEMO.shop.shop_name}!\nI'm your AI assistant.\nHow can I help you today?`,
    promptVersion: "llama-3.3-70b-versatile · engine v1.0",
    isOpen: true,
    isDemo: true,
    serverTime: new Date().toISOString(),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTS — updated
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build the technician roster response for demo mode.
 * Matches handleTechniciansList() in api/shop.js — real names/phones/skills,
 * with per-technician active-job counts derived from the demo bookings.
 */
function buildDemoTechniciansResponse() {
  const ACTIVE_STATUSES = ["assigned", "on_the_way", "arrived", "in_progress", "waiting_parts"];
  const technicians = TECHNICIANS.map((t, i) => {
    const activeJobs = BOOKINGS.filter((b) => b.techIdx === i && ACTIVE_STATUSES.includes(b.status)).length;
    return {
      id: i + 1,
      name: t.name,
      phone: t.phone,
      email: t.email,
      services: t.services,
      specialization: t.specialization,
      active: t.active,
      active_jobs: activeJobs,
      total_jobs: BOOKINGS.filter((b) => b.techIdx === i).length,
      created_at: new Date(Date.now() - (i + 3) * 86400000 * 30).toISOString(),
    };
  });
  return { technicians };
}

module.exports = {
  DEMO,
  ago,
  generateRevenueChart,
  pick,
  randInt,
  // Cache & Performance
  DEMO_CACHE,
  isCacheValid,
  invalidateDemoCache,
  perfMark,
  perfReport,
  deterministicAgo,
  // Response builders
  buildDemoDashboardResponse,
  buildDemoBookingDetailResponse,
  buildDemoNotificationsResponse,
  buildDemoAiSettingsResponse,
  buildDemoShopSettingsResponse,
  buildDemoReferralsResponse,
  buildDemoWhatsAppLogsResponse,
  buildDemoWhatsAppStatusResponse,
  buildDemoSubscriptionResponse,
  buildDemoWidgetSettingsResponse,
  buildDemoSandboxStatusResponse,
  buildDemoTechniciansResponse,
};
