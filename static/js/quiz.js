document.addEventListener("DOMContentLoaded", async () => {
  const api = window.DentalPrepApi;
  if (!api) return;

  if (!api.requireAuth()) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const quizId = params.get("id");

  const titleEl = document.getElementById("quiz-title");
  const metaEl = document.getElementById("quiz-meta");
  const formEl = document.getElementById("quiz-form");
  const submitBtn = document.getElementById("submit-quiz");
  const resultEl = document.getElementById("quiz-result");
  const backLink = document.getElementById("quiz-back-link");

  if (!quizId) {
    if (titleEl) titleEl.textContent = "Quiz not found";
    if (metaEl) metaEl.textContent = "Missing quiz id";
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  let quiz = null;

  const showResult = (text, type = "success") => {
    if (!resultEl) return;
    resultEl.innerHTML = `<div class="result-banner" style="background: ${
      type === "success" ? "#ecfdf3" : "#fef2f2"
    }; color: ${type === "success" ? "#166534" : "#991b1b"}; border: 1px solid ${
      type === "success" ? "#bbf7d0" : "#fecaca"
    }">${text}</div>`;
  };

  const clearQuestionFeedback = () => {
    if (!formEl) return;

    formEl.querySelectorAll(".question-feedback").forEach((el) => el.remove());
    formEl.querySelectorAll(".option-correct, .option-wrong, .option-correct-answer").forEach((el) => {
      el.classList.remove("option-correct", "option-wrong", "option-correct-answer");
    });
  };

  const renderQuestionFeedback = (question, selectedIndex) => {
    if (!formEl) return false;

    const card = formEl.querySelector(`[data-question-id='${question.id}']`);
    if (!card) return false;

    const correctIndex = question.options.findIndex((opt) => opt === question.correctAnswer);
    const isAnswered = Number.isInteger(selectedIndex);
    const isCorrect = isAnswered && selectedIndex === correctIndex;

    const feedback = document.createElement("div");
    feedback.className = "question-feedback";

    if (!isAnswered) {
      feedback.classList.add("feedback-unanswered");
      feedback.textContent = "Not answered. Correct answer: " + question.correctAnswer;
      card.appendChild(feedback);
      return false;
    }

    if (isCorrect) {
      feedback.classList.add("feedback-correct");
      feedback.textContent = "Correct";
    } else {
      feedback.classList.add("feedback-wrong");
      feedback.textContent = "Wrong. Correct answer: " + question.correctAnswer;
    }

    const selectedOption = card.querySelector(`input[name='${question.id}'][value='${selectedIndex}']`)?.closest("label");
    const correctOption = card.querySelector(`input[name='${question.id}'][value='${correctIndex}']`)?.closest("label");

    if (selectedOption) {
      selectedOption.classList.add(isCorrect ? "option-correct" : "option-wrong");
    }
    if (correctOption && !isCorrect) {
      correctOption.classList.add("option-correct-answer");
    }

    card.appendChild(feedback);
    return isCorrect;
  };

  try {
    const data = await api.apiFetch(`/quizzes/${quizId}`);
    quiz = data.quiz;

    if (titleEl) titleEl.textContent = quiz.title;
    if (metaEl) metaEl.textContent = `${quiz.questions.length} questions`;
    if (backLink && quiz.courseId) {
      backLink.href = `/course-player/?id=${encodeURIComponent(quiz.courseId)}`;
    }

    if (formEl) {
      formEl.innerHTML = "";
      quiz.questions.forEach((question, index) => {
        const card = document.createElement("div");
        card.className = "question-card";
        card.setAttribute("data-question-id", question.id);
        card.innerHTML = `
          <div style="font-weight: 700;">${index + 1}. ${question.question}</div>
        `;
        question.options.forEach((option, optionIndex) => {
          const optionId = `${question.id}-${optionIndex}`;
          const wrapper = document.createElement("label");
          wrapper.className = "option";
          wrapper.innerHTML = `
            <input type="radio" name="${question.id}" value="${optionIndex}" id="${optionId}">
            <span>${option}</span>
          `;
          card.appendChild(wrapper);
        });
        formEl.appendChild(card);
      });
    }
  } catch (err) {
    if (titleEl) titleEl.textContent = "Quiz not found";
    if (metaEl) metaEl.textContent = err.message || "Unable to load quiz";
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      if (!quiz) return;

      clearQuestionFeedback();

      let correct = 0;
      quiz.questions.forEach((question) => {
        const selected = formEl.querySelector(`input[name='${question.id}']:checked`);
        const selectedIndex = selected ? Number(selected.value) : null;
        const isCorrect = renderQuestionFeedback(question, selectedIndex);
        if (isCorrect) {
          correct += 1;
        }
      });

      const score = Math.round((correct / quiz.questions.length) * 100);
      showResult(`You scored ${score}% (${correct}/${quiz.questions.length} correct)`);

      try {
        await api.apiFetch("/progress", {
          method: "POST",
          body: JSON.stringify({
            courseId: quiz.courseId,
            lessonId: quiz.lessonId,
            quizId: quiz.id,
            itemType: "quiz",
            title: quiz.title,
            completed: true,
            score
          })
        });
        showResult(`You scored ${score}% (${correct}/${quiz.questions.length} correct). Result saved.`);
      } catch (err) {
        showResult(err.message || "Unable to save score.", "error");
      }
    });
  }
});
