# Encodium : audit operations local du 2026-09-05

## Deploiement production verifie

Le correctif a ete fusionne et deploye le 2026-09-05 apres succes du pipeline
GitLab 358. Revision deployee sur les deux instances :
`df75333bee887460743f18265f7310375bcc3656`. Le deploiement GitLab 134 est
enregistre en succes dans l'environnement `production`.

- Sauvegarde froide : `/var/backups/encodium/20260905T151025Z-20247`, mode
  0700 root:root. Elle contient les deux anciennes applications, les deux
  configurations, les deux unites systemd et un dump commun des bases. Les
  repertoires `data` existants n'ont pas ete remplaces.
- Aucun job queued/running/probing/encoding et aucun processus FFmpeg n'etait
  actif avant l'arret coordonne des deux services.
- Runtime dedie installe et controle par checksum : Node 24.20.0 sous
  `/usr/local/lib/encodium-node`. Les deux unites l'utilisent.
- Chaque instance a `COOKIE_SECURE=true`, `TRUST_PROXY=192.168.1.100` et son
  unique origine HTTPS dans `CORS_ORIGINS`. Aucun secret n'est consigne ici.
- `encodium.service` et `encodiumPlex.service` sont actifs avec `NRestarts=0`.
  Healthcheck local et session signee ephemere : `/api/auth/me` retourne 200 ;
  un login mal forme de meme origine retourne 400 ; une origine etrangere est
  refusee avec 403 sur les deux instances.
- Les quatre controles publics anonymes, dont les deux domaines Encodium,
  redirigent avec 302 vers `pangolin.hbtz.fr`. Aucune session SSO n'a ete
  contournee ou simulee.

Point de rollback : la sauvegarde ci-dessus et la revision precedente de chaque
application. Un rollback de donnees exige un nouvel arret coordonne et une revue
des changements survenus depuis le deploiement ; il ne doit pas ecraser les
repertoires `data` par defaut.

## Etat avant deploiement : photographie historique

Cette verification complete les limites du sous-audit local ci-dessous ; ce
n'est pas un deploiement des corrections.

- CT111-Encodium : `encodium.service`, `/opt/Encodium`, port 4000, et
  `encodiumPlex.service`, `/opt/EncodiumPlex`, port 5000, actifs sous `plex`.
- Runtime observe : Node 20.20.2. Prevoir une version LTS maintenue et testee
  avec FFmpeg et les permissions des deux instances avant un prochain rollout.
- Routage Pangolin confirme : `encodium.hbtz.fr` -> CT111:4000 et
  `encodiumplex.hbtz.fr` -> CT111:5000, HTTPS public, HTTP upstream, site Maison
  en ligne. CT100-DNS heberge Newt. Les GET publics anonymes retournent 302 vers
  `pangolin.hbtz.fr` ; aucune session SSO contournee.
- Le processus Encodium ne declare ni TRUST_PROXY, ni COOKIE_SECURE, ni
  CORS_ORIGINS. Preparer chaque instance avant le nouveau controle Origin :
  COOKIE_SECURE=true, TRUST_PROXY limite au connecteur CT100 verifie, et
  CORS_ORIGINS limite au domaine HTTPS propre a l'instance si necessaire.
  Tester login et cookies avec un vrai Origin HTTPS ; ne pas reutiliser une
  unique origine pour les deux instances.
- CT105 runner shell : Node 20.20.2, npm 10.8.2 ; Go 1.26.7 confirme.
  Disque : 89% utilise, 3.6 Gio libres. Aucun prune ou changement runner.
- Projet GitLab 2, dernier pipeline main initial 289 success pour `30abcc2`.
  Aucun ancien job manuel retourne. Publication prevue sur branche de revue,
  sans fusion ni restart.
- Aucun parametre, fichier, secret, queue ou droit de production modifie.
  Sauvegarde coherente des deux DB/sorties, drainage des jobs et rollback
  restent des prerequis de deploiement.

## Perimetre et conclusion

Corrections locales uniquement de `.gitlab-ci.yml` et `install.sh`, ajout de
`ops-static-test.sh` et de ce rapport. `deploy/*` lu, non modifie ; aucun
`scripts/install*` present. Code applicatif, tests des autres agents et rapport
`AUDIT-2026-09-05.md` inchanges par cette intervention. Base locale `30abcc2`,
branche `main`, remote existant `ssh://git@git.hbtz.fr/homelab/encodium.git`.

**Validation/packaging seulement, pas d'autorisation de deploiement.** Aucun
commit, stage, push, fetch, SSH, nouveau runner, bot CI ou remote. Aucun installateur,
receiver, service ou base de production execute/consulte. Publication CI au parent.
La suppression locale ne modifie pas les anciens pipelines deja crees : le parent
doit verifier/annuler leurs jobs deploy avant publication, sans les lancer.

## Corrections

| Priorite | Constat prouve dans les fichiers | Correction |
| --- | --- | --- |
| P1 | La CI proposait encore `root@192.168.1.111`, ancien chemin TCP/22 apres cutover Teleport. | Job et stage deploy supprimes. Aucun remplacement administratif CI. Tags et journalisation Node/npm du runner existant conserves. |
| P2 | Le tar du workspace excluait `.env`, mais pas toutes les variantes non suivies `.env.*`. | Packaging par `git archive HEAD`, donc seulement le commit valide, jamais les fichiers locaux non suivis ou caches du runner. Le controle de secrets existant reste necessaire pour les fichiers suivis. |
| P1 | `RUN_USER=$(whoami)` pouvait donner un runtime root ; npm install pouvait executer des lifecycle scripts et resoudre hors lockfile. | Preflight refuse EUID=0 ; service conserve le vrai utilisateur appelant, sans inventer d'UID. `npm ci --omit=dev --ignore-scripts`. |
| P1 | Reexecution sur `.env` existant : suppression des guillemets des credentials puis ALTER USER et reecriture par sed. | Refus explicite si `.env` existe, y compris symlink casse, avant toute installation. Pas de parseur compatible improvise ni de rotation de secrets. |
| P1 | `create_admin` executait `.env` comme shell alors que `db.js:15` charge deja dotenv. | Source shell retire ; le parseur applicatif existant reste l'autorite. |
| P1 | Kill global MariaDB et kill -9 de tout listener du port applicatif, sans preuve d'appartenance. Fallback chmod 777 du socket DB. | Refus sur processus DB existant ou port occupe, pas de kill global. Socket cree avec mysql:mysql et 0755, erreur de chown non masquee. |
| P2 | Mot de passe admin affiche dans le resume, donc dans un journal/audit potentiel. | ADMIN_PASS requis avant bootstrap, jamais affiche dans le resume. Pas de nouveau fichier secret. |

References : `.gitlab-ci.yml:23-44`, `install.sh:48-55`, `:194-216`, `:297-300`,
`:444`, `:525-529`, `:599-603`, `:717-722`.

## Limites et relais

1. **Installateur historique, pas une procedure de mise a jour fiable.** Le refus
   d'une configuration existante est intentionnel, pas un upgrade idempotent. Un
   bootstrap partiellement termine peut exiger une reprise operateur. Ne pas
   supprimer `.env` pour contourner ce refus. Aucune configuration runtime inspectee.
2. **Node et telechargements non modernises.** `install_node` accepte >=18 et
   installe Node 20 via nvm (`install.sh:92-109`) ; ces versions ne constituent pas
   une cible maintenue a la date de cet audit. L'installateur n'est donc pas certifie
   pour une installation neuve. Parent : choisir/verifier une version Node maintenue
   sur le runner shell existant, sans creer de runner ni upgrader la toolchain ici.
   Le rapport applicatif a teste Node hote 20.19.2, ce n'est pas une mesure du runner.
3. **SQL et bootstrap restants.** Identifiants/mots de passe externes restent
   interpoles dans le SQL (`setup_database`). Les anciennes branches de lecture/
   reecriture `.env` restent dans les fonctions mais sont bloquees par le preflight
   du parcours normal ; ne pas sourcer l'installateur ou appeler ces fonctions
   seules. Pas de test root, PM2/systemd, sudo, GPU, ACL, mounts ou reprise apres echec.
   Le fallback rand_string sans openssl et les erreurs d'initialisation DB masquees
   restent a revoir avant un bootstrap reel.
4. **Receivers historiques non autorises.** `deploy/encodium-ci-receiver` et
   `deploy/encodium-deploy` sont conserves, mais ne sont plus appeles par la CI.
   Ne pas installer/reactiver leurs anciennes cles TCP/22. La reception dans un nom
   `/tmp` previsible, l'absence de verrou global, la validation tar avant/apres
   extraction incomplete, les privileges npm et le rollback de donnees ne sont pas
   certifies. La liste de membres et le rejet des symlinks apres extraction ne
   suffisent pas a valider tous les types de liens tar. Aucune archive hostile executee.
5. **Acces runtime historique.** Les controles existants de staging 0755 et de
   lecture npm par `plex` dans `deploy/encodium-deploy` sont conserves et testes
   statiquement ; aucune propriete/permission live n'a ete changee. La preservation
   `.env`/`data` dans rsync n'est pas une preuve de sauvegarde ou de recuperabilite.
6. **Exposition web.** Appliquer le relais proxy/origines/cookies du rapport
   applicatif avant toute mise en production. Aucune confiance proxy universelle
   ajoutee. Aucun domaine public ou parametre runtime invente.

## Tests executes

Depuis `/opt/encodium`, tous avec code 0 :

```bash
bash ops-static-test.sh
bash -n ops-static-test.sh
git diff --check
```

Le test dedie execute `bash -n` sur `install.sh` et les deux scripts `deploy/`,
puis controle les contrats CI, lockfile, UID, secrets, absence de source `.env`,
absence de kills globaux et garde-fous de lecture runtime historiques. Il ne
source ni n'execute ces fichiers. Ajoute au job verify, sans dependance nouvelle.

Validation locale complementaire : `python3 /tmp/opencode/validate-ops.py`
(PyYAML 6.0.2, Bash 5.2.37), code 0. YAML CI parse, deux jobs/stages autorises,
scripts YAML bien scalaires et syntaxe Bash de chaque commande ; comparaison au
HEAD montrant l'ancien SSH. `git archive --format=tar.gz HEAD` inspecte en memoire :
entrees attendues presentes, secrets `.env*` hors exemple/caches absents. Ce test
d'archive porte sur le HEAD encore commite, pas sur les corrections non commitees.
Le parent doit inclure tous les fichiers voulus dans son commit avant publication.

Le reformatage automatique induit par l'editeur a ete retire ; equivalence
canonique `shfmt` controlee avant/apres cette restauration de formatage.
Suites applicatives non relancees ici : leurs resultats sont dans le rapport de
l'agent applicatif, pas revendiques comme nouveaux tests ops. Aucun pipeline
GitLab distant ni environnement de production valide.
