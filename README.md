# GeoFS Dogfight Combined

Fusion adaptée des deux scripts GeoFS fournis : radar B-scope, combat libre multijoueur, missiles/canon, contre-mesures, sélection des pylônes et catalogue de modèles 3D.

## Contenu

- `geofs-dogfight.user.js` : userscript Tampermonkey à installer dans le navigateur.
- `api/ws.js` : serveur WebSocket Vercel. Il valide les tirs entre pilotes du même salon, les impacts, les points de vie et les leurres.
- `package.json` : dépendances serveur.
- `vercel.json` : durée maximale de la fonction WebSocket.

## Déploiement du serveur

Cette version utilise Vercel + Upstash Redis. Netlify n'est pas retenu ici : Vercel propose un endpoint WebSocket natif dans ses Functions, ce qui simplifie la synchronisation en direct.

1. Créer une base Redis sur Upstash, puis créer un projet Vercel à partir du dossier `geofs-dogfight` (ou pousser le dossier dans un dépôt GitHub et importer ce dépôt dans Vercel).
2. Relier la base Upstash au projet Vercel, ou ajouter manuellement les variables d'environnement `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` avec les valeurs fournies par Upstash.
3. Déployer le projet. Vercel doit installer les dépendances de `package.json` et publier `api/ws.js` à l'adresse `/api/ws`.
4. Vérifier que Fluid Compute est activé dans les paramètres du projet Vercel.
5. Ouvrir `geofs-dogfight.user.js` et remplacer la ligne `WS_URL` par l'adresse de ton projet, par exemple :

   `const WS_URL = 'wss://mon-projet.vercel.app/api/ws';`

6. Enregistrer le fichier, l'installer dans Tampermonkey et activer le script.

Le serveur utilise Redis pour partager la présence et les événements entre les instances Vercel. Les variables Redis restent côté serveur : ne les colle jamais dans le userscript.

## Utilisation dans GeoFS

1. Chaque joueur installe le même userscript configuré avec la même URL Vercel.
2. Dans le panneau `GEOFS // DOGFIGHT`, chacun saisit le même code de salon (choisir un code difficile à deviner) et son propre indicatif.
3. Cliquer sur `REJOINDRE LE SALON`.
4. Sélectionner un pilote dans `CONTACTS DU SALON`, puis cliquer sur `DÉFINIR COMME CIBLE`. Aucun échange d'invitation ou d'acceptation n'est nécessaire.
5. Activer l'armement avec Entrée, sélectionner le missile dans le menu ou avec W, puis tirer avec Espace.
6. Maintenir D pour le canon. Maj déclenche manuellement la contre-mesure ; l'option `AUTO-LEURRES : ON` déclenche automatiquement le type de leurre attendu lorsqu'un missile arrive.

## Touches

| Touche | Action |
|---|---|
| Entrée | Activer / désactiver l'armement |
| W | Passer au missile suivant |
| Espace | Tirer le missile sélectionné |
| D (maintenue) | Tirer au canon |
| Maj | Déclencher les leurres / paillettes |

## Ce qui est réellement fonctionnel dans cette version

- Les neuf missiles air-air du premier addon, plus l'AIM-54 visible dans le catalogue du deuxième, ont un profil de portée, de vitesse, de dégâts et de contre-mesure côté serveur : AIM-9, AIM-9C, AIM-120, AIM-54, R-27EA, R-27R, R-27T, R-33, R-73 et R-77.
- Le canon applique des dégâts si la cible sélectionnée dans le salon est à moins de 1,5 km et dans un cône de visée étroit.
- Les missiles créent une menace entrante affichant le nom de l'arme et le type de contre-mesure attendu.
- Les contre-mesures sont consommées côté serveur et peuvent faire échouer le missile si le type est adapté.
- Le radar B-scope affiche les pilotes présents dans le même salon, avec quatre échelles de portée.
- Les modèles de pylônes et d'emports de l'addon 2 peuvent être chargés visuellement. Le catalogue `weapons-vehicles.js` est récupéré depuis le dépôt d'origine.

## Limites importantes

- Les GBU, AGM et autres charges air-sol trouvées dans le catalogue de l'addon 2 sont disponibles comme modèles visuels, mais ne sont pas transformées en missiles air-air. Le premier addon ne contient pas leur logique de tir.
- Les dégâts sont synchronisés sous forme de points de vie virtuels. À 0 %, le pilote est annoncé comme neutralisé et son système d'armement local est désactivé ; ce script ne peut pas forcer le moteur GeoFS à casser l'avion distant, couper physiquement ses commandes ou provoquer son crash. Cela demanderait une modification ou une API officielle côté serveur GeoFS.
- Le ciblage et la position proviennent des clients GeoFS. C'est adapté à des parties privées entre amis, pas à un serveur compétitif anti-triche.
- Le mode est un combat libre : chaque pilote peut sélectionner et attaquer n’importe quel autre pilote connecté au même salon.
- Les pylônes sont chargés à la position d'origine `[0,0,0]`, comme dans le script fourni. Selon l'avion sélectionné, le modèle peut nécessiter un réglage manuel.
- Les fonctions internes de GeoFS et les URL des modèles peuvent évoluer. Le script a été vérifié syntaxiquement, mais n'a pas été exécuté dans une session GeoFS réelle avec deux comptes ; un essai en vol est nécessaire avant une partie complète.
