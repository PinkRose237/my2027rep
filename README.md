# The Next Congress

A countdown to the start of the 120th Congress and a side-by-side address lookup for the 119th and 120th congressional delegations. The site uses plain HTML, CSS and JavaScript and is published on GitHub Pages.

## Run locally

Run `python3 -m http.server 8071` from the repository and open `http://localhost:8071/`.

Run `python3 scripts/refresh_data.py` to refresh the committed data snapshot. Pass `--campaigns` to recheck candidate profiles that did not supply a campaign URL. GitHub Actions also refreshes the deployed data every six hours and on manual runs. If a scheduled refresh fails, the previous deployment remains online.

## Data

- The [Twentieth Amendment](https://constitution.congress.gov/constitution/amendment-20/) sets the term change at noon Eastern on January 3, 2027.
- The browser sends address queries to [Esri](https://developers.arcgis.com/rest/geocode/) for address suggestions and matching. It sends coordinates to [Census TIGERweb](https://tigerweb.geo.census.gov/tigerweb/) to compare the 119th and 120th district boundaries. Missouri used the 119th map in the 2026 general election.
- The [House Clerk](https://clerk.house.gov/Members), [U.S. Senate](https://www.senate.gov/senators/contact/) and [Congress Legislators](https://github.com/unitedstates/congress-legislators) supply roster and office data.
- [civicAPI](https://civicapi.org/) supplies voting House and Senate election calls. Individual delegate race sources are linked in the results. [Votewiser](https://votewiser.com/) and candidates’ own sites supply campaign links.
- The Capitol photograph is by the [Architect of the Capitol](https://commons.wikimedia.org/wiki/File:Capitol_at_Dusk_View_from_Library_of_Congress_Jefferson_Building_(14144445175).jpg). The bundled font licenses are in `assets/`.
