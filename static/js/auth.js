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
        setToken(data.token);
        showMessage(signupForm, "Account created. Redirecting...", "success");
        setTimeout(() => {
          window.location.href = "/dashboard/";
        }, 800);
      } catch (err) {
        showMessage(signupForm, err.message || "Signup failed.");
      } finally {
        setLoading(submitBtn, false);
      }
    });
  }
});
