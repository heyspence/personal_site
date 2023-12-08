const dashDoorViewButton = document.querySelector('.view-dash-door')
const nuggetRushViewButton = document.querySelector('.view-nugget-rush')
const homeKeeperViewButton = document.querySelector('.view-home-keeper')
const dashdoorModal = document.querySelector('.dashdoor-modal')
const nuggetRushModal = document.querySelector('.nugget-rush-modal')
const homeKeeperModal = document.querySelector('.home-keeper-modal')
const closeIcons = document.querySelectorAll('.close-icon')
const modals = document.querySelectorAll('.modal')

const revealElement = (element) => {
    if(element.classList.contains("hidden")){
        element.classList.remove("hidden")
    }
}

const hideElement = (element) => {
    if(!element.classList.contains("hidden")){
        element.classList.add("hidden")
    }
}

dashDoorViewButton.addEventListener("click", ()=>{
    revealElement(dashdoorModal)
})

nuggetRushViewButton.addEventListener("click", ()=>{
    revealElement(nuggetRushModal)
})

homeKeeperViewButton.addEventListener("click", ()=>{
    revealElement(homeKeeperModal)
})

closeIcons.forEach(icon => {
    icon.addEventListener('click', (e) => {
        if(e.target === icon){
            modals.forEach(modal => {
                hideElement(modal)
            })
        }
    })
})

modals.forEach(modal => {
    modal.addEventListener('click', (e) => {
        if(e.target === modal){
            hideElement(modal);
        }
    })
})