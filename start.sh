adb shell pm list packages -3 > packages.txt

if [ ! -f packages.txt ]; then
  echo "packages.txt was not created."
  echo ""
  echo "Please enable USB debugging on your Android phone and try again:"
  echo "1. Open Settings on your phone."
  echo "2. Go to About phone."
  echo "3. Tap Build number 7 times to enable Developer options."
  echo "4. Go back to Settings."
  echo "5. Open Developer options."
  echo "6. Enable USB debugging."
  echo "7. Reconnect the phone to your computer."
  echo "8. If prompted on the phone, allow USB debugging for this computer."
  echo ""
  echo "Then run this script again."
  exit 1
fi

npx ts-node --transpile-only check-wear.ts
