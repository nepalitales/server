export const TEST_CHECKOUT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nepali Tales | Live Razorpay & Auto-Refund Test Suite</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>

  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(17, 24, 39, 0.7);
      --card-border: rgba(255, 255, 255, 0.08);
      --card-border-glow: rgba(230, 57, 70, 0.3);
      --primary: #e63946;
      --primary-hover: #f04e5b;
      --primary-glow: rgba(230, 57, 70, 0.25);
      --accent: #f4a261;
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.2);
      --warning: #f59e0b;
      --danger: #ef4444;
      --text-main: #f9fafb;
      --text-muted: #9ca3af;
      --text-subtle: #6b7280;
      --mono-font: 'JetBrains Mono', monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(230, 57, 70, 0.12) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(244, 162, 97, 0.08) 0px, transparent 50%),
        radial-gradient(at 50% 50%, rgba(16, 185, 129, 0.05) 0px, transparent 50%);
      background-attachment: fixed;
      color: var(--text-main);
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 32px 16px 64px;
    }

    .container {
      width: 100%;
      max-width: 940px;
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
      padding-bottom: 8px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-logo {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, #e63946, #c1121f);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 4px 16px var(--primary-glow);
    }

    .brand-title h1 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
      background: linear-gradient(90deg, #ffffff, #e5e7eb);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-title p {
      font-size: 13px;
      color: var(--text-muted);
    }

    .badge-live {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 9999px;
      color: var(--success);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    .grid {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 24px;
    }

    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }

    .card {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--card-border);
      border-radius: 18px;
      padding: 24px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
      position: relative;
      overflow: hidden;
    }

    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, rgba(230, 57, 70, 0.4), transparent);
    }

    .card-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: #fff;
    }

    .form-group {
      margin-bottom: 14px;
    }

    .form-group label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .form-input {
      width: 100%;
      padding: 10px 14px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      color: #fff;
      font-family: inherit;
      font-size: 14px;
      transition: all 0.2s;
    }

    .form-input:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-glow);
    }

    .item-box {
      background: rgba(255, 255, 255, 0.02);
      border: 1px dashed var(--card-border);
      border-radius: 12px;
      padding: 14px;
      margin: 18px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .item-desc {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .item-name {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
    }

    .item-sub {
      font-size: 12px;
      color: var(--text-subtle);
    }

    .item-price {
      font-size: 18px;
      font-weight: 700;
      color: var(--accent);
    }

    .btn {
      width: 100%;
      padding: 14px 20px;
      border: none;
      border-radius: 12px;
      font-family: inherit;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
    }

    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      filter: grayscale(0.5);
    }

    .btn-pay {
      background: linear-gradient(135deg, #e63946, #c1121f);
      color: #fff;
      box-shadow: 0 4px 18px var(--primary-glow);
      margin-bottom: 12px;
    }

    .btn-pay:hover:not(:disabled) {
      background: linear-gradient(135deg, #f04e5b, #cf1424);
      transform: translateY(-1px);
      box-shadow: 0 6px 24px rgba(230, 57, 70, 0.4);
    }

    .btn-refund {
      background: linear-gradient(135deg, #7c3aed, #6d28d9);
      color: #fff;
      box-shadow: 0 4px 18px rgba(124, 58, 237, 0.25);
    }

    .btn-refund:hover:not(:disabled) {
      background: linear-gradient(135deg, #8b5cf6, #7c3aed);
      transform: translateY(-1px);
      box-shadow: 0 6px 24px rgba(124, 58, 237, 0.4);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-muted);
      border: 1px solid var(--card-border);
      padding: 8px 14px;
      font-size: 12px;
      border-radius: 8px;
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }

    .status-stepper {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-top: 8px;
    }

    .step-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      position: relative;
    }

    .step-item:not(:last-child)::after {
      content: '';
      position: absolute;
      left: 14px;
      top: 28px;
      bottom: -10px;
      width: 2px;
      background: rgba(255, 255, 255, 0.08);
    }

    .step-item.completed:not(:last-child)::after {
      background: var(--success);
    }

    .step-icon {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      flex-shrink: 0;
      color: var(--text-muted);
      transition: all 0.3s;
    }

    .step-item.active .step-icon {
      background: var(--primary);
      border-color: var(--primary);
      color: #fff;
      box-shadow: 0 0 12px var(--primary-glow);
    }

    .step-item.completed .step-icon {
      background: var(--success);
      border-color: var(--success);
      color: #fff;
      box-shadow: 0 0 12px var(--success-glow);
    }

    .step-content {
      flex: 1;
    }

    .step-title {
      font-size: 13px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 2px;
    }

    .step-desc {
      font-size: 12px;
      color: var(--text-subtle);
    }

    .console-card {
      background: #06090e;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      overflow: hidden;
      font-family: var(--mono-font);
    }

    .console-header {
      background: rgba(255, 255, 255, 0.03);
      padding: 10px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      font-size: 12px;
      color: var(--text-muted);
    }

    .console-dots {
      display: flex;
      gap: 6px;
    }

    .console-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    .console-body {
      padding: 14px;
      max-height: 220px;
      overflow-y: auto;
      font-size: 12px;
      line-height: 1.6;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .log-line {
      display: flex;
      gap: 8px;
      word-break: break-all;
    }

    .log-time {
      color: var(--text-subtle);
      flex-shrink: 0;
    }

    .log-info { color: #60a5fa; }
    .log-success { color: #34d399; }
    .log-warn { color: #fbbf24; }
    .log-error { color: #f87171; }
    .log-refund { color: #c084fc; }

    .info-strip {
      background: rgba(255, 255, 255, 0.03);
      border-radius: 10px;
      padding: 10px 14px;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      margin-top: 14px;
      color: var(--text-muted);
    }

    .info-strip strong {
      color: #fff;
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="brand">
        <div class="brand-logo">🥟</div>
        <div class="brand-title">
          <h1>Nepali Tales &bull; Live Payment & Refund Tester</h1>
          <p>Instant End-to-End Razorpay Verification with Real UPI</p>
        </div>
      </div>
      <div class="badge-live">
        <span class="pulse-dot"></span>
        Live Gateway (₹2.00)
      </div>
    </header>

    <div class="grid">
      <div class="card">
        <div class="card-title">
          <span>🛒 1. Live Test Order Details</span>
        </div>

        <div class="form-group">
          <label>Customer Name</label>
          <input id="inputName" type="text" class="form-input" value="Ankit Bhavarthe" />
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div class="form-group">
            <label>Customer Email (Receipts)</label>
            <input id="inputEmail" type="email" class="form-input" value="bhavartheankit@gmail.com" />
          </div>
          <div class="form-group">
            <label>UPI Phone Number</label>
            <input id="inputPhone" type="tel" class="form-input" value="917678097659" />
          </div>
        </div>

        <div class="item-box">
          <div class="item-desc">
            <span class="item-name">🥟 Nepali Tales UPI Verification Cart</span>
            <span class="item-sub">Production Gateway Test Order &bull; Auto-Refundable</span>
          </div>
          <div class="item-price">₹2.00</div>
        </div>

        <button id="btnPay" class="btn btn-pay" onclick="handleStartPayment()">
          <span id="btnPaySpinner" class="spinner" style="display: none;"></span>
          <span id="btnPayText">⚡ Step 1: Pay ₹2 with Live UPI (Razorpay)</span>
        </button>

        <button id="btnRefund" class="btn btn-refund" onclick="handleCancelAndRefund()" disabled>
          <span id="btnRefundSpinner" class="spinner" style="display: none;"></span>
          <span id="btnRefundText">🔄 Step 2: Cancel Order & Instant Auto-Refund (₹2)</span>
        </button>

        <div id="activeOrderStrip" class="info-strip" style="display: none;">
          <span>Order: <strong id="lblOrderId">-</strong></span>
          <span>Payment: <strong id="lblPaymentId">-</strong></span>
          <span>Status: <strong id="lblStatus">Pending</strong></span>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="justify-content: space-between;">
          <span>📋 2. Real-Time Pipeline Tracker</span>
          <button class="btn-secondary" onclick="checkOrderStatus()">Check Status</button>
        </div>

        <div class="status-stepper">
          <div id="stepOrder" class="step-item">
            <div class="step-icon">1</div>
            <div class="step-content">
              <div class="step-title">Razorpay Order Creation</div>
              <div id="stepOrderDesc" class="step-desc">Generates live ₹2 order ID on Razorpay API</div>
            </div>
          </div>

          <div id="stepPayment" class="step-item">
            <div class="step-icon">2</div>
            <div class="step-content">
              <div class="step-title">Live UPI Payment & Webhook</div>
              <div id="stepPaymentDesc" class="step-desc">Scan QR on GPay/PhonePe and complete payment</div>
            </div>
          </div>

          <div id="stepEmail" class="step-item">
            <div class="step-icon">3</div>
            <div class="step-content">
              <div class="step-title">Confirmation Email Dispatched</div>
              <div id="stepEmailDesc" class="step-desc">Resend sends HTML confirmation receipt</div>
            </div>
          </div>

          <div id="stepRefund" class="step-item">
            <div class="step-icon">4</div>
            <div class="step-content">
              <div class="step-title">Instant Auto-Refund & Cancellation</div>
              <div id="stepRefundDesc" class="step-desc">Razorpay API executes refund directly to your UPI ID</div>
            </div>
          </div>
        </div>

        <div style="margin-top: 20px; font-size: 11px; color: var(--text-subtle); line-height: 1.5;">
          💡 <strong>Tip:</strong> You can pay with any UPI app (GPay, PhonePe, Paytm, CRED). As soon as the transaction succeeds, click <em>Step 2</em> to immediately trigger the live Razorpay refund back to your account!
        </div>
      </div>
    </div>

    <div class="console-card">
      <div class="console-header">
        <div class="console-dots">
          <div class="console-dot" style="background: #ef4444;"></div>
          <div class="console-dot" style="background: #f59e0b;"></div>
          <div class="console-dot" style="background: #10b981;"></div>
        </div>
        <span>Live System Audit Logs</span>
        <div style="display: flex; gap: 8px; align-items: center;">
          <span style="font-size: 11px; opacity: 0.6;">api.nepalitales.com</span>
          <button class="btn-secondary" style="padding: 2px 8px; font-size: 11px;" onclick="clearLogs()">Clear</button>
        </div>
      </div>
      <div id="consoleBody" class="console-body">
        <div class="log-line">
          <span class="log-time">[System Ready]</span>
          <span class="log-info">Ready to test live ₹2 payment and refund loop. Click "Step 1" to begin.</span>
        </div>
      </div>
    </div>
  </div>

  <script>
    const API_BASE = window.location.origin.includes("nepalitales.com") 
      ? window.location.origin 
      : "https://api.nepalitales.com";

    let currentOrderId = null;
    let currentRazorpayOrderId = null;
    let currentPaymentId = null;

    function log(msg, type = "info") {
      const now = new Date();
      const timeStr = now.toTimeString().split(" ")[0];
      const consoleBody = document.getElementById("consoleBody");
      
      const div = document.createElement("div");
      div.className = "log-line";
      div.innerHTML = '<span class="log-time">[' + timeStr + ']</span> <span class="log-' + type + '">' + msg + '</span>';
      consoleBody.appendChild(div);
      consoleBody.scrollTop = consoleBody.scrollHeight;
    }

    function clearLogs() {
      document.getElementById("consoleBody").innerHTML = "";
      log("Console cleared.", "info");
    }

    async function handleStartPayment() {
      const btnPay = document.getElementById("btnPay");
      const btnPaySpinner = document.getElementById("btnPaySpinner");
      const btnPayText = document.getElementById("btnPayText");

      const name = document.getElementById("inputName").value.trim();
      const email = document.getElementById("inputEmail").value.trim();
      const phone = document.getElementById("inputPhone").value.trim();

      if (!name || !email || !phone) {
        alert("Please provide customer name, email, and phone.");
        return;
      }

      btnPay.disabled = true;
      btnPaySpinner.style.display = "inline-block";
      btnPayText.textContent = "Creating ₹2 Razorpay Order...";

      log("Initiating ₹2 order creation for " + name + " (" + email + ")...", "info");

      try {
        const res = await fetch(API_BASE + "/api/client/test-payment/create-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerName: name,
            customerEmail: email,
            customerPhone: phone
          })
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
          throw new Error(data.message || "Failed to create order");
        }

        currentOrderId = data.orderId;
        currentRazorpayOrderId = data.razorpayOrderId;

        log("Order created! NT Order: " + data.orderNumber + " | RZP ID: " + data.razorpayOrderId, "success");

        document.getElementById("stepOrder").classList.add("completed");
        document.getElementById("stepOrderDesc").textContent = "Created: " + data.orderNumber + " (" + data.razorpayOrderId + ")";
        document.getElementById("stepPayment").classList.add("active");

        document.getElementById("activeOrderStrip").style.display = "flex";
        document.getElementById("lblOrderId").textContent = data.orderNumber;
        document.getElementById("lblStatus").textContent = "Awaiting UPI Payment";

        launchRazorpayModal({
          keyId: data.keyId,
          amount: data.amount,
          orderId: data.razorpayOrderId,
          name: name,
          email: email,
          phone: phone
        });

      } catch (err) {
        log("Order creation failed: " + err.message, "error");
        alert("Error creating order: " + err.message);
      } finally {
        btnPay.disabled = false;
        btnPaySpinner.style.display = "none";
        btnPayText.textContent = "⚡ Step 1: Pay ₹2 with Live UPI (Razorpay)";
      }
    }

    function launchRazorpayModal(opts) {
      log("Opening Razorpay Checkout modal (Key: " + opts.keyId + ")...", "info");

      const options = {
        key: opts.keyId,
        amount: opts.amount,
        currency: "INR",
        name: "Nepali Tales",
        description: "Live Payment & Instant Refund Verification (₹2.00)",
        order_id: opts.orderId,
        prefill: {
          name: opts.name,
          email: opts.email,
          contact: opts.phone,
        },
        theme: {
          color: "#E63946"
        },
        handler: async function (response) {
          log("Payment received from Razorpay SDK! Payment ID: " + response.razorpay_payment_id, "success");
          currentPaymentId = response.razorpay_payment_id;
          document.getElementById("lblPaymentId").textContent = response.razorpay_payment_id;

          await handleVerifyPayment({
            orderId: currentOrderId,
            razorpayOrderId: response.razorpay_order_id,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpaySignature: response.razorpay_signature
          });
        },
        modal: {
          ondismiss: function () {
            log("Razorpay Checkout dismissed/closed by user.", "warn");
          }
        }
      };

      const rzp = new Razorpay(options);
      rzp.on("payment.failed", function (resp) {
        log("Payment failed: " + resp.error.description + " (Code: " + resp.error.code + ")", "error");
      });
      rzp.open();
    }

    async function handleVerifyPayment(payload) {
      log("Verifying HMAC-SHA256 signature with Nepali Tales API...", "info");

      try {
        const res = await fetch(API_BASE + "/api/client/test-payment/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.message || "Payment verification failed");
        }

        log("Payment verified successfully! Confirmation email queued to " + document.getElementById("inputEmail").value + ".", "success");

        document.getElementById("stepPayment").classList.remove("active");
        document.getElementById("stepPayment").classList.add("completed");
        document.getElementById("stepPaymentDesc").textContent = "Captured: " + payload.razorpayPaymentId;

        document.getElementById("stepEmail").classList.add("completed");
        document.getElementById("stepEmailDesc").textContent = "Receipt sent via Resend (orders@nepalitales.com)";

        document.getElementById("lblStatus").textContent = "Paid & Placed";
        document.getElementById("lblStatus").style.color = "#10b981";

        const btnRefund = document.getElementById("btnRefund");
        btnRefund.disabled = false;
        document.getElementById("stepRefund").classList.add("active");

        log("Step 2 is now unlocked! Click 'Step 2: Cancel Order & Instant Auto-Refund' to test live refund.", "warn");

      } catch (err) {
        log("Payment verification failed: " + err.message, "error");
        alert("Payment verification error: " + err.message);
      }
    }

    async function handleCancelAndRefund() {
      if (!currentOrderId) {
        alert("No active order to refund.");
        return;
      }

      const btnRefund = document.getElementById("btnRefund");
      const btnRefundSpinner = document.getElementById("btnRefundSpinner");
      const btnRefundText = document.getElementById("btnRefundText");

      btnRefund.disabled = true;
      btnRefundSpinner.style.display = "inline-block";
      btnRefundText.textContent = "Processing Live Refund...";

      log("Requesting cancellation & full ₹2 refund for order " + currentOrderId + "...", "refund");

      try {
        const res = await fetch(API_BASE + "/api/client/test-payment/cancel-and-refund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: currentOrderId })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.message || "Refund request failed");
        }

        log("SUCCESS! Razorpay Refund Initiated: ID " + data.refundId + " | Amount: ₹" + data.refundAmount, "success");
        log("Refund status: '" + data.status + "'. Money will credit back to your UPI account!", "refund");

        document.getElementById("stepRefund").classList.remove("active");
        document.getElementById("stepRefund").classList.add("completed");
        document.getElementById("stepRefundDesc").textContent = "Refunded: ₹" + data.refundAmount + " (ID: " + data.refundId + ")";

        document.getElementById("lblStatus").textContent = "Cancelled & Refunded";
        document.getElementById("lblStatus").style.color = "#c084fc";

        btnRefundText.textContent = "✅ ₹2 Refund Processed via Razorpay";

      } catch (err) {
        log("Refund failed: " + err.message, "error");
        alert("Refund error: " + err.message);
        btnRefund.disabled = false;
        btnRefundText.textContent = "🔄 Step 2: Cancel Order & Instant Auto-Refund (₹2)";
      } finally {
        btnRefundSpinner.style.display = "none";
      }
    }

    async function checkOrderStatus() {
      if (!currentOrderId) {
        log("No order has been created yet. Click 'Step 1' first.", "warn");
        return;
      }

      log("Fetching live status from DB for order " + currentOrderId + "...", "info");
      try {
        const res = await fetch(API_BASE + "/api/client/test-payment/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: currentOrderId })
        });

        const data = await res.json();
        if (data.success && data.order) {
          const ord = data.order;
          log("DB Order Status: " + ord.status + " | Payment: " + ord.payment?.status + " (ID: " + (ord.payment?.razorpayPaymentId || "none") + ") | Refund: " + (ord.refund?.status || "none"), "info");
          if (ord.refund?.razorpayRefundId) {
            log("Refund Record Found: " + ord.refund.razorpayRefundId + " (Amount: ₹" + ord.refund.amount + ")", "refund");
          }
        }
      } catch (err) {
        log("Status check error: " + err.message, "error");
      }
    }
  </script>
</body>
</html>
`;
