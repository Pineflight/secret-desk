/** Sammelt alle Namensraeume. Schluessel beginnen mit dem Namensraum, zum Beispiel "secrets.title". */
import commonDe from "./common.de";
import commonEn from "./common.en";
import homeDe from "./home.de";
import homeEn from "./home.en";
import secretsDe from "./secrets.de";
import secretsEn from "./secrets.en";
import secretDetailDe from "./secretDetail.de";
import secretDetailEn from "./secretDetail.en";
import variablesDe from "./variables.de";
import variablesEn from "./variables.en";
import metaDe from "./meta.de";
import metaEn from "./meta.en";
import reviewsDe from "./reviews.de";
import reviewsEn from "./reviews.en";
import approvalsDe from "./approvals.de";
import approvalsEn from "./approvals.en";
import devDe from "./dev.de";
import devEn from "./dev.en";
import connectionsDe from "./connections.de";
import connectionsEn from "./connections.en";
import teamDe from "./team.de";
import teamEn from "./team.en";
import teamSyncDe from "./teamsync.de";
import teamSyncEn from "./teamsync.en";
import reposDe from "./repos.de";
import settingsDe from "./settings.de";
import settingsEn from "./settings.en";
import reposEn from "./repos.en";
import compareDe from "./compare.de";
import compareEn from "./compare.en";
import paramsDe from "./params.de";
import paramsEn from "./params.en";

export const messages: Record<"de" | "en", Record<string, string>> = {
  de: { ...commonDe, ...homeDe, ...secretsDe, ...secretDetailDe, ...variablesDe, ...metaDe, ...reviewsDe, ...approvalsDe, ...devDe, ...connectionsDe, ...teamDe, ...teamSyncDe, ...reposDe, ...settingsDe, ...compareDe, ...paramsDe },
  en: { ...commonEn, ...homeEn, ...secretsEn, ...secretDetailEn, ...variablesEn, ...metaEn, ...reviewsEn, ...approvalsEn, ...devEn, ...connectionsEn, ...teamEn, ...teamSyncEn, ...reposEn, ...settingsEn, ...compareEn, ...paramsEn },
};
