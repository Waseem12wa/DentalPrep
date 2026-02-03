const dotenv = require("dotenv");
const connectDb = require("./config/db");
const Course = require("./models/Course");
const Lesson = require("./models/Lesson");
const Quiz = require("./models/Quiz");

dotenv.config();

const data = {
  courses: [
    {
      courseId: "course_dentistry_fundamentals",
      title: "Dentistry Fundamentals"
    }
  ],
  lessons: [
    {
      lessonId: "vid001_anatomy",
      courseId: "course_dentistry_fundamentals",
      title: "Dental Anatomy Basics",
      videoUrl: "https://www.youtube.com/watch?v=ihA3x5Jkuzs",
      quizId: "quiz001_anatomy"
    },
    {
      lessonId: "vid002_caries",
      courseId: "course_dentistry_fundamentals",
      title: "Caries Detection & Diagnosis",
      videoUrl: "https://www.youtube.com/watch?v=5tRT8WxXw2I",
      quizId: "quiz002_caries"
    },
    {
      lessonId: "vid003_endodontics",
      courseId: "course_dentistry_fundamentals",
      title: "Intro to Endodontics",
      videoUrl: "https://www.youtube.com/watch?v=L_Mp-Tv3T4s",
      quizId: "quiz003_endodontics"
    }
  ],
  quizzes: [
    {
      quizId: "quiz001_anatomy",
      courseId: "course_dentistry_fundamentals",
      lessonId: "vid001_anatomy",
      title: "Dental Anatomy Basics",
      questions: [
        {
          id: "q1",
          question: "What is the hardest substance in the human body?",
          options: ["Bone", "Dentin", "Enamel", "Cementum"],
          correctAnswer: "Enamel"
        },
        {
          id: "q2",
          question: "How many permanent teeth are normally present in adults?",
          options: ["20", "24", "28", "32"],
          correctAnswer: "32"
        }
      ]
    },
    {
      quizId: "quiz002_caries",
      courseId: "course_dentistry_fundamentals",
      lessonId: "vid002_caries",
      title: "Caries Detection and Diagnosis",
      questions: [
        {
          id: "q1",
          question: "What is the primary cause of dental caries?",
          options: ["Trauma", "Bacterial plaque", "Genetics", "Fluoride use"],
          correctAnswer: "Bacterial plaque"
        },
        {
          id: "q2",
          question: "Which of the following bacteria is strongly associated with caries?",
          options: [
            "Streptococcus mutans",
            "Lactobacillus acidophilus",
            "Candida albicans",
            "Porphyromonas gingivalis"
          ],
          correctAnswer: "Streptococcus mutans"
        }
      ]
    },
    {
      quizId: "quiz003_endodontics",
      courseId: "course_dentistry_fundamentals",
      lessonId: "vid003_endodontics",
      title: "Introduction to Endodontic Treatment",
      questions: [
        {
          id: "q1",
          question: "What is the main goal of endodontic treatment?",
          options: [
            "Remove enamel",
            "Preserve tooth pulp",
            "Eliminate infection from root canal",
            "Replace missing teeth"
          ],
          correctAnswer: "Eliminate infection from root canal"
        }
      ]
    }
  ]
};

const seed = async () => {
  await connectDb();

  await Course.deleteMany({});
  await Lesson.deleteMany({});
  await Quiz.deleteMany({});

  await Course.insertMany(data.courses);
  await Lesson.insertMany(data.lessons);
  await Quiz.insertMany(data.quizzes);

  console.log("Seed completed");
  process.exit(0);
};

seed().catch((err) => {
  console.error("Seed failed", err);
  process.exit(1);
});
