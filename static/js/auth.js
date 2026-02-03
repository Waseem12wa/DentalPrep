document.addEventListener("DOMContentLoaded", () => {
  const { apiFetch, setToken, clearToken, getToken } = window.DentalPrepApi || {};

  if (!apiFetch) {
    return;
  }

  const loginForm = document.querySelector("form[data-auth='login']");
  const signupForm = document.querySelector("form[data-auth='signup']");

  const showMessage = (form, text, type = "error") => {
    if (!form) return;
    let banner = form.querySelector(".auth-message");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "auth-message";
      banner.style.marginBottom = "1rem";
      banner.style.padding = "0.75rem 1rem";
      banner.style.borderRadius = "0.5rem";
      banner.style.fontSize = "0.95rem";
      form.prepend(banner);
    }
    banner.style.background = type === "success" ? "#ecfdf3" : "#fef2f2";
    banner.style.color = type === "success" ? "#166534" : "#991b1b";
    banner.style.border = type === "success" ? "1px solid #bbf7d0" : "1px solid #fecaca";
    banner.textContent = text;
  };

  const setLoading = (button, loading) => {
    if (!button) return;
    button.disabled = loading;
    button.style.opacity = loading ? "0.7" : "1";
  };

  if (getToken() && (loginForm || signupForm)) {
    window.location.href = "/dashboard/";
    return;
  }

  if (loginForm) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = loginForm.querySelector("#email").value.trim();
      const password = loginForm.querySelector("#password").value;
      const submitBtn = loginForm.querySelector("button[type='submit']");

      if (!email || !password) {
        showMessage(loginForm, "Please enter email and password.");
        return;
      }

      setLoading(submitBtn, true);

      try {
        const data = await apiFetch("/login", {
          method: "POST",
          body: JSON.stringify({ email, password })
        });
        setToken(data.token);
        showMessage(loginForm, "Login successful. Redirecting...", "success");
        setTimeout(() => {
          window.location.href = "/dashboard/";
        }, 800);
      } catch (err) {
        showMessage(loginForm, err.message || "Login failed.");
      } finally {
        setLoading(submitBtn, false);
      }
    });
  }

  if (signupForm) {
    signupForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = signupForm.querySelector("input[name='full_name']").value.trim();
      const email = signupForm.querySelector("input[name='email']").value.trim();
      const password = signupForm.querySelector("input[name='password']").value;
      const passwordConfirm = signupForm.querySelector("input[name='password_confirm']").value;
      const submitBtn = signupForm.querySelector("button[type='submit']");

      if (!name || !email || !password) {
        showMessage(signupForm, "Please fill all required fields.");
        return;
      }

      if (password !== passwordConfirm) {
        showMessage(signupForm, "Passwords do not match.");
        return;
      }

      setLoading(submitBtn, true);

      try {
        const data = await apiFetch("/signup", {
          method: "POST",
          body: JSON.stringify({ name, email, password })
        });
        // We do NOT set token immediately on signup anymore if we wait for verification
        // But for User Experience in this demo, the backend returns a token anyway.
        // The message says "check email". 

        showMessage(signupForm, data.message || "Account created.", "success");
        // Optional: clear form
        signupForm.reset();
      } catch (err) {
        showMessage(signupForm, err.message || "Signup failed.");
      } finally {
        setLoading(submitBtn, false);
      }
    });
  }

  // Forgot Password
  const forgotForm = document.querySelector("form[data-auth='forgot-password']");
  if (forgotForm) {
    forgotForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = forgotForm.querySelector("input[name='email']").value.trim();
      const btn = forgotForm.querySelector("button");

      if (!email) return showMessage(forgotForm, "Email is required");

      setLoading(btn, true);
      try {
        const data = await apiFetch("/forgot-password", {
          method: "POST",
          body: JSON.stringify({ email })
        });
        showMessage(forgotForm, data.message, "success");
      } catch (err) {
        showMessage(forgotForm, err.message);
      } finally {
        setLoading(btn, false);
      }
    });
  }

  // Reset Password
  const resetForm = document.querySelector("form[data-auth='reset-password']");
  if (resetForm) {
    resetForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get("token");
      const password = resetForm.querySelector("input[name='password']").value;
      const btn = resetForm.querySelector("button");

      if (!token) return showMessage(resetForm, "Missing reset token.");
      if (!password) return showMessage(resetForm, "Password is required");

      setLoading(btn, true);
      try {
        const data = await apiFetch("/reset-password", {
          method: "POST",
          body: JSON.stringify({ token, password })
        });
        showMessage(resetForm, data.message, "success");
        setTimeout(() => window.location.href = "/login/", 1500);
      } catch (err) {
        showMessage(resetForm, err.message);
      } finally {
        setLoading(btn, false);
      }
    });
  }
});
