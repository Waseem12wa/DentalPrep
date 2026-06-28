document.addEventListener("DOMContentLoaded", () => {
  const api = window.DentalPrepApi;
  if (!api) return;

  // Show Dashboard link if logged in
  const token = api.getToken();
  const navDashboard = document.getElementById("nav-dashboard");
  if (token && navDashboard) {
    navDashboard.classList.remove("hidden");
  }

  const handleAuthRoute = (event) => {
    const token = api.getToken();
    if (token) {
      event.preventDefault();
      window.location.href = "/learning/";
    }
  };

  document.querySelectorAll("[data-auth-route]").forEach((el) => {
    el.addEventListener("click", handleAuthRoute);
  });

  document.querySelectorAll("[data-plan]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const plan = button.getAttribute("data-plan");

      // Map 'mbbs'/'bds' to 'annual' for now or keep distinct if backend supports it
      // Based on pricing section, plans are trial, monthly, annual.
      // The MBBS/BDS cards in index.html (lines 494/529) use 'mbbs'/'bds' but have Annual features.
      // Let's map them to 'annual' for simplicity in this demo, or pass them as is.
      // Passing as is allows future differentiation.

      let checkoutPlan = plan;
      if (plan === 'mbbs' || plan === 'bds') checkoutPlan = 'annual';

      if (!api.getToken()) {
        // If not logged in, go to signup with redirect intent
        // Simplified: go to signup
        window.location.href = "/signup/";
        return;
      }

      window.location.href = `/checkout/?plan=${checkoutPlan}`;
    });
  });

  // Bank Details Modal logic
  const bankLink = document.getElementById("nav-bank-details");
  const modal = document.getElementById("bank-details-modal");
  const closeBtn = document.getElementById("close-bank-modal");

  if (bankLink && modal && closeBtn) {
    bankLink.addEventListener("click", async (e) => {
      e.preventDefault();
      modal.style.display = "flex";

      try {
        const apiBase = api.getApiBase();
        const response = await fetch(`${apiBase}/public/academy-profile`);
        if (!response.ok) throw new Error("Failed to fetch");
        const data = await response.json();
        
        if (data.bankDetails) {
          document.getElementById("modal-bank-name").textContent = data.bankDetails.bankName || "N/A";
          document.getElementById("modal-account-title").textContent = data.bankDetails.accountTitle || "N/A";
          document.getElementById("modal-account-number").textContent = data.bankDetails.accountNumber || "N/A";
          document.getElementById("modal-iban").textContent = data.bankDetails.iban || "N/A";
        } else {
          document.querySelectorAll("#bank-details-modal .detail-value").forEach(el => {
            el.textContent = "Not Configured";
          });
        }
      } catch (err) {
        console.error("Error fetching bank details:", err);
        document.querySelectorAll("#bank-details-modal .detail-value").forEach(el => {
          el.textContent = "Error loading details";
        });
      }
    });

    closeBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });

    window.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.style.display = "none";
      }
    });
  }
});

