#!/bin/bash
cd /opt/astramap
rm -f astra_extension.zip
zip -r astra_extension.zip extension/ -x "*/node_modules/*" -x "*/.gitkeep"
ls -lh astra_extension.zip
echo "✅ http://186.246.2.6:5001/astra_extension.zip"
