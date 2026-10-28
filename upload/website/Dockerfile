FROM nginx:1.30.6-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security_headers.conf /etc/nginx/security_headers.conf

# Nur der Inhalt von static/ kommt ins Image, nie der Rest des Projekts
COPY static/ /usr/share/nginx/html/
