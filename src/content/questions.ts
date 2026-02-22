/**
 * Question Bank - Sample questions for Apologia Sancta
 */

import type { Teaching } from "../types/quiz";

/** Full question data including correct answer and teaching */
export interface QuestionData {
  text: string;
  choices: {
    id: string;
    label: string;
    text: string;
  }[];
  correctId: string;
  teaching: Teaching;
  themeTitle: string;
}

/**
 * Sample question bank (5-10 questions)
 */
export const QUESTION_BANK: QuestionData[] = [
  {
    themeTitle: "CHRISTOLOGY",
    text: "Which council affirmed the divinity of Christ?",
    choices: [
      { id: "a", label: "A", text: "Council of Nicaea" },
      { id: "b", label: "B", text: "Council of Ephesus" },
      { id: "c", label: "C", text: "Council of Chalcedon" },
      { id: "d", label: "D", text: "Council of Trent" },
    ],
    correctId: "a",
    teaching: {
      title: "Teaching Moment",
      body: 'The Council of Nicaea in 325 AD affirmed that Jesus is "True God from True God," defining the doctrine of the Trinity.',
      refs: ["Nicene Creed", "CCC 465", "St. Athanasius"],
      isOpenByDefault: true,
    },
  },
  {
    themeTitle: "MARIOLOGY",
    text: "What title was given to Mary at the Council of Ephesus?",
    choices: [
      { id: "a", label: "A", text: "Mediatrix" },
      { id: "b", label: "B", text: "Theotokos" },
      { id: "c", label: "C", text: "Queen of Heaven" },
      { id: "d", label: "D", text: "Immaculata" },
    ],
    correctId: "b",
    teaching: {
      title: "Teaching Moment",
      body: 'The Council of Ephesus in 431 AD declared Mary as "Theotokos" (God-bearer), affirming that Jesus was truly God from the moment of conception.',
      refs: ["Council of Ephesus", "CCC 466", "St. Cyril of Alexandria"],
      isOpenByDefault: true,
    },
  },
  {
    themeTitle: "SACRAMENTS",
    text: "How many sacraments are there in the Catholic Church?",
    choices: [
      { id: "a", label: "A", text: "Five" },
      { id: "b", label: "B", text: "Six" },
      { id: "c", label: "C", text: "Seven" },
      { id: "d", label: "D", text: "Eight" },
    ],
    correctId: "c",
    teaching: {
      title: "Teaching Moment",
      body: "The seven sacraments are: Baptism, Confirmation, Eucharist, Penance, Anointing of the Sick, Holy Orders, and Matrimony.",
      refs: ["CCC 1113", "Council of Trent", "St. Thomas Aquinas"],
      isOpenByDefault: true,
    },
  },
  {
    themeTitle: "ECCLESIOLOGY",
    text: "Who is considered the first Pope?",
    choices: [
      { id: "a", label: "A", text: "St. Paul" },
      { id: "b", label: "B", text: "St. Peter" },
      { id: "c", label: "C", text: "St. James" },
      { id: "d", label: "D", text: "St. John" },
    ],
    correctId: "b",
    teaching: {
      title: "Teaching Moment",
      body: 'Jesus said to Peter: "You are Peter, and on this rock I will build my Church" (Mt 16:18). Peter became the first Bishop of Rome.',
      refs: ["Matthew 16:18-19", "CCC 881", "St. Irenaeus"],
      isOpenByDefault: true,
    },
  },
  {
    themeTitle: "SCRIPTURE",
    text: "How many books are in the Catholic Bible?",
    choices: [
      { id: "a", label: "A", text: "66" },
      { id: "b", label: "B", text: "72" },
      { id: "c", label: "C", text: "73" },
      { id: "d", label: "D", text: "76" },
    ],
    correctId: "c",
    teaching: {
      title: "Teaching Moment",
      body: "The Catholic Bible contains 73 books: 46 in the Old Testament and 27 in the New Testament, including the deuterocanonical books.",
      refs: ["CCC 120", "Council of Trent", "St. Jerome"],
      isOpenByDefault: true,
    },
  },
  {
    themeTitle: "MORALITY",
    text: "What are the theological virtues?",
    choices: [
      { id: "a", label: "A", text: "Prudence, Justice, Fortitude" },
      { id: "b", label: "B", text: "Faith, Hope, Charity" },
      { id: "c", label: "C", text: "Humility, Patience, Kindness" },
      { id: "d", label: "D", text: "Wisdom, Understanding, Counsel" },
    ],
    correctId: "b",
    teaching: {
      title: "Teaching Moment",
      body: "Faith, Hope, and Charity are the theological virtues. They are infused by God and direct us toward Him as our ultimate end.",
      refs: ["1 Corinthians 13:13", "CCC 1812-1829", "St. Paul"],
      isOpenByDefault: true,
    },
  },
  {
    themeTitle: "LITURGY",
    text: "What is the source and summit of Christian life?",
    choices: [
      { id: "a", label: "A", text: "Prayer" },
      { id: "b", label: "B", text: "Scripture" },
      { id: "c", label: "C", text: "The Eucharist" },
      { id: "d", label: "D", text: "Confession" },
    ],
    correctId: "c",
    teaching: {
      title: "Teaching Moment",
      body: '"The Eucharist is the source and summit of the Christian life" (Lumen Gentium 11). All other sacraments are ordered toward it.',
      refs: ["Lumen Gentium 11", "CCC 1324", "Vatican II"],
      isOpenByDefault: true,
    },
  },
  {
    themeTitle: "SAINTS",
    text: "Who wrote the Summa Theologica?",
    choices: [
      { id: "a", label: "A", text: "St. Augustine" },
      { id: "b", label: "B", text: "St. Thomas Aquinas" },
      { id: "c", label: "C", text: "St. Bonaventure" },
      { id: "d", label: "D", text: "St. Anselm" },
    ],
    correctId: "b",
    teaching: {
      title: "Teaching Moment",
      body: "St. Thomas Aquinas (1225-1274), the Angelic Doctor, wrote the Summa Theologica, one of the most influential works in Catholic theology.",
      refs: ["Summa Theologica", "CCC 43", "Fides et Ratio"],
      isOpenByDefault: true,
    },
  },
  {
    themeTitle: "PRAYER",
    text: "What prayer did Jesus teach His disciples?",
    choices: [
      { id: "a", label: "A", text: "The Hail Mary" },
      { id: "b", label: "B", text: "The Our Father" },
      { id: "c", label: "C", text: "The Glory Be" },
      { id: "d", label: "D", text: "The Apostles' Creed" },
    ],
    correctId: "b",
    teaching: {
      title: "Teaching Moment",
      body: 'The Our Father (Lord\'s Prayer) was taught by Jesus to His disciples when they asked "Lord, teach us to pray." It is the model of all Christian prayer.',
      refs: ["Matthew 6:9-13", "CCC 2759-2865", "Luke 11:1-4"],
      isOpenByDefault: true,
    },
  },
  {
    themeTitle: "ESCHATOLOGY",
    text: "What are the Last Things (Four Last Things)?",
    choices: [
      { id: "a", label: "A", text: "Birth, Life, Death, Resurrection" },
      { id: "b", label: "B", text: "Death, Judgment, Heaven, Hell" },
      { id: "c", label: "C", text: "Faith, Hope, Love, Grace" },
      { id: "d", label: "D", text: "Creation, Fall, Redemption, Glory" },
    ],
    correctId: "b",
    teaching: {
      title: "Teaching Moment",
      body: "The Four Last Things are Death, Judgment, Heaven, and Hell. Meditation on these truths helps orient our lives toward our eternal destiny.",
      refs: ["CCC 1020-1050", "Hebrews 9:27", "St. Augustine"],
      isOpenByDefault: true,
    },
  },
];

/**
 * Get total number of questions
 */
export function getTotalQuestions(): number {
  return QUESTION_BANK.length;
}

/**
 * Get question by index (wraps around)
 */
export function getQuestion(index: number): QuestionData {
  const safeIndex = index % QUESTION_BANK.length;
  return QUESTION_BANK[safeIndex]!;
}
